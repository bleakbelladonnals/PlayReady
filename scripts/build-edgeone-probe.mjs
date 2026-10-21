import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'dist/edgeone-probe');
const privateDirectory = join(root, '.ludoready-private');
const guardFile = join(privateDirectory, 'edgeone-probe.json');
const defaultFixture = join(root, '.ludoready-web/projects/4547a1a4-1d32-4332-bdbd-d0c5808457f2');
const fixture = process.argv[2] ? resolve(process.argv[2]) : defaultFixture;

await readFile(join(root, 'dist/web-client/index.html'));
await readFile(join(fixture, 'public/index.html'));
await readFile(join(fixture, '.ludoready/playtest.json'));
await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
let guard;
try { guard = JSON.parse(await readFile(guardFile, 'utf8')).guard; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (typeof guard !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(guard)) {
  guard = randomBytes(32).toString('base64url');
  await writeFile(guardFile, JSON.stringify({ guard }, null, 2), { mode: 0o600 });
}
const guardHash = createHash('sha256').update(guard).digest('hex');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, 'dist/web-client'), output, { recursive: true });
const privateFixture = join(output, 'agents/_private/fixture');
await cp(join(fixture, 'public'), join(privateFixture, 'public'), { recursive: true });
await mkdir(join(privateFixture, '.ludoready'), { recursive: true });
await cp(join(fixture, '.ludoready/playtest.json'), join(privateFixture, '.ludoready/playtest.json'));

const files = [];
async function collect(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('Fixture symlinks are not allowed');
    if (entry.isDirectory()) await collect(path, relativePath);
    else if (entry.isFile()) files.push({ path: relativePath, base64: (await readFile(path)).toString('base64') });
  }
}
await collect(join(privateFixture, 'public'), 'public');
files.push({ path: '.ludoready/playtest.json', base64: (await readFile(join(privateFixture, '.ludoready/playtest.json'))).toString('base64') });

await build({
  stdin: {
    contents: `import { runtimeProbe } from './src/web/edgeone/probe.ts';\nconst config = ${JSON.stringify({ guardHash, files })};\nexport async function onRequest(context) { return runtimeProbe(context, config); }`,
    resolveDir: root, loader: 'ts', sourcefile: 'edgeone-probe-entry.ts',
  },
  outfile: join(output, 'agents/_probe.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['playwright', 'playwright-core'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
await mkdir(join(output, 'agents/runtime-check'), { recursive: true });
await writeFile(join(output, 'agents/runtime-check/index.ts'), "import { onRequest as probe } from '../_probe.mjs';\nexport async function onRequest(context: any) { return probe(context); }\n");
for (const dependency of ['playwright', 'playwright-core']) {
  await cp(join(root, 'node_modules', dependency), join(output, 'node_modules', dependency), { recursive: true });
}
const playwright = JSON.parse(await readFile(join(root, 'node_modules/playwright/package.json'), 'utf8'));
const blob = JSON.parse(await readFile(join(root, 'node_modules/@edgeone/pages-blob/package.json'), 'utf8'));
await writeFile(join(output, 'package.json'), JSON.stringify({ name: 'ludoready-edgeone-probe', private: true, type: 'module', engines: { node: '>=22' }, dependencies: { '@edgeone/pages-blob': blob.version, playwright: playwright.version, 'playwright-core': playwright.version } }, null, 2));
await writeFile(join(output, 'edgeone.json'), JSON.stringify({ agents: { dir: 'agents', timeout: 1800, sandbox: { timeout: 3600 }, externalNodeModules: ['playwright', 'playwright-core'] } }, null, 2));
console.log(`Prepared ${output}; ${files.length} fixture files. Probe guard stays in ${guardFile}.`);
