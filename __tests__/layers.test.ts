import {mkdir, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  BUNDLE_MANIFEST,
  bundleObjects,
  overlayLayer,
  restoreBaselineManifest,
  subtractBaseline
} from '../src/layers.js'

async function bundle(root: string, name: string, files: Record<string, string>): Promise<string> {
  const directory = path.join(root, name)
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(directory, ...relative.split('/'))
    await mkdir(path.dirname(file), {recursive: true})
    await writeFile(file, contents)
  }
  return directory
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {recursive: true, withFileTypes: true})
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

const native = (relative: string): string => relative.split('/').join(path.sep)

describe('pull request cache layers', () => {
  it('leaves the objects the baseline carries out of a layer', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-layers-'))
    const baseline = await bundle(root, 'baseline', {
      [BUNDLE_MANIFEST]: 'baseline',
      'cas/v1/aa/shared': 'dependency',
      'action-results/v1/aa/dependency': 'result'
    })
    const exported = await bundle(root, 'export', {
      [BUNDLE_MANIFEST]: 'layer',
      'cas/v1/aa/shared': 'dependency',
      'cas/v1/bb/changed': 'edited crate',
      'action-results/v1/aa/dependency': 'result',
      'action-results/v1/bb/changed': 'result'
    })

    const objects = await bundleObjects(baseline)
    expect(objects).toEqual([native('cas/v1/aa/shared')])
    expect(await subtractBaseline(exported, new Set(objects))).toEqual({
      objects: 1,
      bytes: 'dependency'.length
    })
    // Action results are small and stay, so the layer names every action it
    // carries whichever baseline it lands on.
    expect(await files(exported)).toEqual([
      'action-results/v1/aa/dependency',
      'action-results/v1/bb/changed',
      'cas/v1/bb/changed',
      BUNDLE_MANIFEST
    ])
  })

  it('counts every byte it leaves out when removing concurrently', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-layers-'))
    const shared = Object.fromEntries(
      Array.from({length: 64}, (_, index) => [`cas/v1/${index % 8}/object-${index}`, 'x'.repeat(100)])
    )
    const exported = await bundle(root, 'export', {[BUNDLE_MANIFEST]: 'layer', ...shared})
    const baseline = new Set(Object.keys(shared).map(native))

    expect(await subtractBaseline(exported, baseline)).toEqual({objects: 64, bytes: 6400})
    expect(await files(exported)).toEqual([BUNDLE_MANIFEST])
  })

  it('lists no objects for a bundle without any', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-layers-'))
    expect(await bundleObjects(path.join(root, 'missing'))).toEqual([])
  })

  it('lays a layer over its baseline under the layer manifest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-layers-'))
    const baseline = await bundle(root, 'baseline', {
      [BUNDLE_MANIFEST]: 'baseline',
      'cas/v1/aa/shared': 'dependency',
      'action-results/v1/aa/dependency': 'baseline result'
    })
    const layer = await bundle(root, 'layer', {
      [BUNDLE_MANIFEST]: 'layer',
      'cas/v1/bb/changed': 'edited crate',
      'action-results/v1/aa/dependency': 'layer result',
      'action-results/v1/bb/changed': 'result'
    })
    const backup = path.join(root, 'baseline.manifest')

    await overlayLayer(baseline, layer, backup)
    expect(await files(baseline)).toEqual([
      'action-results/v1/aa/dependency',
      'action-results/v1/bb/changed',
      'cas/v1/aa/shared',
      'cas/v1/bb/changed',
      BUNDLE_MANIFEST
    ])
    expect(await readFile(path.join(baseline, BUNDLE_MANIFEST), 'utf8')).toBe('layer')
    // The baseline keeps its own copy of anything both carry, so falling back
    // to it after a rejected layer finds it exactly as it was restored.
    expect(
      await readFile(path.join(baseline, 'action-results', 'v1', 'aa', 'dependency'), 'utf8')
    ).toBe('baseline result')
    await expect(readdir(layer)).rejects.toThrow()

    await restoreBaselineManifest(baseline, backup)
    expect(await readFile(path.join(baseline, BUNDLE_MANIFEST), 'utf8')).toBe('baseline')
  })
})
