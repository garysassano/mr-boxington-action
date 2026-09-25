import {lstat, mkdir, readdir, rename, rm, stat} from 'node:fs/promises'
import path from 'node:path'

/**
 * The one file in an mbx directory bundle that is not content-addressed. It
 * names the actions, task predictions, and attachments the bundle carries;
 * everything else sits under `cas/v1` or `action-results/v1`.
 */
export const BUNDLE_MANIFEST = 'mbx-cache-export-v1.json'
const CAS_ROOT = 'cas'

async function exists(entry: string): Promise<boolean> {
  try {
    await lstat(entry)
    return true
  } catch {
    return false
  }
}

/**
 * Run `task` over `items` a few at a time. A layer or a closure is thousands of
 * small files, and one filesystem call after another leaves the restore
 * waiting on each round trip in turn.
 */
async function eachConcurrently<T>(
  items: readonly T[],
  task: (item: T) => Promise<void>,
  limit = 32
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await task(items[next++] as T)
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker))
}

async function bundleFiles(bundle: string, below = ''): Promise<string[]> {
  const root = path.join(bundle, below)
  if (!(await exists(root))) return []
  const entries = await readdir(root, {recursive: true, withFileTypes: true})
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.relative(bundle, path.join(entry.parentPath, entry.name)))
    .sort()
}

/**
 * The content-addressed objects in a directory bundle, relative to it.
 *
 * An object's path is its digest, so two bundles that list the same path hold
 * the same bytes there. That is what lets a pull request's layer leave out
 * whatever its baseline already carries.
 */
export async function bundleObjects(bundle: string): Promise<string[]> {
  return bundleFiles(bundle, CAS_ROOT)
}

/**
 * Lay a pull request's layer over its restored baseline, in the baseline's
 * directory, so `mbx cache import` sees one complete bundle.
 *
 * The layer's manifest replaces the baseline's, which is moved to `backup`
 * rather than deleted: if the layer turns out not to fit this baseline, the
 * import rejects the bundle before it publishes anything, and putting the
 * baseline's manifest back leaves a bundle that imports on its own. A file the
 * baseline already has is kept, so that fallback still finds every one of the
 * baseline's own files unchanged. Objects are content-addressed, so keeping
 * either copy is the same; an action result is small, and the baseline's copy
 * refers only to objects the baseline carries.
 */
export async function overlayLayer(
  baseline: string,
  layer: string,
  backup: string
): Promise<void> {
  const files = (await bundleFiles(layer)).filter(relative => relative !== BUNDLE_MANIFEST)
  const directories = [...new Set(files.map(relative => path.dirname(path.join(baseline, relative))))]
  await eachConcurrently(directories, async directory => {
    await mkdir(directory, {recursive: true})
  })
  await eachConcurrently(files, async relative => {
    const destination = path.join(baseline, relative)
    if (!(await exists(destination))) await rename(path.join(layer, relative), destination)
  })
  await rm(backup, {force: true})
  await rename(path.join(baseline, BUNDLE_MANIFEST), backup)
  await rename(path.join(layer, BUNDLE_MANIFEST), path.join(baseline, BUNDLE_MANIFEST))
  await rm(layer, {recursive: true, force: true})
}

/** Undo `overlayLayer`'s manifest swap after the layer failed to import. */
export async function restoreBaselineManifest(baseline: string, backup: string): Promise<void> {
  await rename(backup, path.join(baseline, BUNDLE_MANIFEST))
}

export interface Subtraction {
  objects: number
  bytes: number
}

/**
 * Remove from an exported bundle every object its baseline already carries,
 * leaving the manifest, every action result, and the objects only this pull
 * request produced.
 */
export async function subtractBaseline(
  bundle: string,
  baselineObjects: ReadonlySet<string>
): Promise<Subtraction> {
  const shared = (await bundleObjects(bundle)).filter(relative => baselineObjects.has(relative))
  let bytes = 0
  await eachConcurrently(shared, async relative => {
    const file = path.join(bundle, relative)
    // Await the size before touching the total: `bytes += await …` reads the
    // total first, so concurrent removals would overwrite each other's sums.
    const {size} = await stat(file)
    bytes += size
    await rm(file)
  })
  return {objects: shared.length, bytes}
}
