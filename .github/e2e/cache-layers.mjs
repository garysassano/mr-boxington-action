// The pull request layer lifecycle against a real mbx: cut a layer from an
// export, lay it over its baseline, and import the two as one bundle. The
// GitHub transport is left out, because this workflow's pull requests never
// save; what is checked is everything the action does to mbx's bundles.
import {spawnSync} from 'node:child_process'
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {
  bundleObjects,
  overlayLayer,
  restoreBaselineManifest,
  subtractBaseline
} from '../../src/layers.ts'

const runnerTemp = process.env.RUNNER_TEMP
if (!runnerTemp) throw new Error('RUNNER_TEMP is not set')
const root = path.join(runnerTemp, 'mbx-e2e-layers')
const workspace = path.join(root, 'workspace')
rmSync(root, {force: true, recursive: true})

// Two crates, so a pull request that edits only `app` shares `shared` with its
// baseline and the layer has something to leave out.
const files = {
  'Cargo.toml': '[workspace]\nmembers = ["shared", "app"]\nresolver = "3"\n',
  'shared/Cargo.toml': '[package]\nname = "shared"\nversion = "0.0.0"\nedition = "2024"\npublish = false\n',
  'shared/src/lib.rs': 'pub fn answer() -> u64 {\n    (1..=10).sum()\n}\n',
  'app/Cargo.toml':
    '[package]\nname = "app"\nversion = "0.0.0"\nedition = "2024"\npublish = false\n\n' +
    '[dependencies]\nshared = { path = "../shared" }\n',
  'app/src/main.rs': 'fn main() {\n    println!("{}", shared::answer());\n}\n'
}
for (const [relative, contents] of Object.entries(files)) {
  const file = path.join(workspace, relative)
  mkdirSync(path.dirname(file), {recursive: true})
  writeFileSync(file, contents)
}
const manifest = path.join(workspace, 'Cargo.toml')

/** One isolated mbx store and target root, as a fresh runner would have. */
function store(name) {
  return {
    ...process.env,
    MBX_CACHE_DIR: path.join(root, name, 'cache'),
    MBX_TARGET_ROOT: path.join(root, name, 'targets'),
    MBX_STATS_REPORT: path.join(root, name, 'stats.json'),
    MBX_GC_AUTO: '0'
  }
}

function mbx(args, env, {cwd = workspace, allowFailure = false} = {}) {
  const result = spawnSync('mbx', args, {cwd, env, stdio: 'inherit'})
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`mbx ${args.join(' ')} exited with ${result.status}`)
  }
  return result.status === 0
}

function build(env, group) {
  rmSync(path.join(workspace, 'target'), {force: true, recursive: true})
  mbx(['build', '--manifest-path', manifest], {...env, MBX_CACHE_EXPORT_GROUP: group})
  return JSON.parse(readFileSync(env.MBX_STATS_REPORT, 'utf8'))
}

// Import from outside the workspace, so mbx does not also rehydrate Cargo's
// target directory and every crate has to come from the imported objects.
const importFrom = (bundle, env) => mbx(['cache', 'import', bundle], env, {cwd: root, allowFailure: true})
const exportGroup = (group, destination, env) =>
  mbx(['cache', 'export', '--group', group, '--format', 'directory', destination], env)

// The default branch's baseline.
const baseline = path.join(root, 'baseline-bundle')
const main = store('main')
build(main, 'layers-e2e-main')
exportGroup('layers-e2e-main', baseline, main)

// A pull request's first run: restore the baseline, edit `app`, and cut a
// layer from its export.
writeFileSync(
  path.join(workspace, 'app', 'src', 'main.rs'),
  'fn main() {\n    println!("pull request {}", shared::answer());\n}\n'
)
const layer = path.join(root, 'layer-bundle')
const first = store('first')
const firstRestore = path.join(root, 'first-restore')
cpSync(baseline, firstRestore, {recursive: true})
const baselineObjects = new Set(await bundleObjects(firstRestore))
if (!importFrom(firstRestore, first)) throw new Error('the baseline did not import')
build(first, 'layers-e2e-pr')
exportGroup('layers-e2e-pr', layer, first)
const exported = (await bundleObjects(layer)).length
const left = await subtractBaseline(layer, baselineObjects)
const layerObjects = await bundleObjects(layer)
if (left.objects === 0 || left.bytes === 0) {
  throw new Error(`the layer left out nothing its baseline holds (${JSON.stringify(left)})`)
}
if (layerObjects.length === 0 || layerObjects.some(object => baselineObjects.has(object))) {
  throw new Error('the layer should hold only objects its baseline lacks')
}
console.log(
  `Cut a layer of ${layerObjects.length} of ${exported} objects, leaving out ${left.objects} (${left.bytes} bytes)`
)

// The pull request's next run: the layer over its baseline must restore every
// crate, the edited one included, without compiling anything.
const second = store('second')
const secondRestore = path.join(root, 'second-restore')
cpSync(baseline, secondRestore, {recursive: true})
const secondLayer = path.join(root, 'second-layer')
cpSync(layer, secondLayer, {recursive: true})
await overlayLayer(secondRestore, secondLayer, `${secondRestore}.manifest`)
if (!importFrom(secondRestore, second)) throw new Error('the layer over its baseline did not import')
const stats = build(second, 'layers-e2e-pr-again')
if (!Number.isInteger(stats.hits) || stats.hits < 2 || stats.misses !== 0) {
  throw new Error(`the layered restore did not supply every crate: ${JSON.stringify(stats)}`)
}
console.log(`Layer over its baseline produced ${stats.hits} hits and no misses`)

// A layer that does not fit its baseline is rejected before anything moves,
// and the baseline then imports on its own.
const third = store('third')
const thirdRestore = path.join(root, 'third-restore')
cpSync(baseline, thirdRestore, {recursive: true})
const thirdLayer = path.join(root, 'third-layer')
cpSync(layer, thirdLayer, {recursive: true})
await overlayLayer(thirdRestore, thirdLayer, `${thirdRestore}.manifest`)
rmSync(path.join(thirdRestore, layerObjects[0]))
if (importFrom(thirdRestore, third)) throw new Error('a layer missing an object was imported')
await restoreBaselineManifest(thirdRestore, `${thirdRestore}.manifest`)
if (!importFrom(thirdRestore, third)) throw new Error('the baseline did not import after the layer was rejected')
console.log('A rejected layer fell back to its baseline')
