import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist/cloudbase-state');
const functionName = 'ludoready-state';
const functionRoot = join(output, 'functions', functionName);
const source = join(root, 'src/web/cloudbase');
const template = join(root, 'docs/cloudbase-state');

// Build a separate package. Never copy repository config, local credentials,
// generated games or test fixtures into this function's upload directory.
await rm(output, { recursive: true, force: true });
await mkdir(functionRoot, { recursive: true });
await cp(join(source, 'state.cjs'), join(functionRoot, 'state.js'));
const original = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
await writeFile(join(functionRoot, 'package.json'), JSON.stringify({
  name: functionName,
  version: original.version,
  private: true,
  main: 'state.js',
  type: 'commonjs',
  engines: { node: '>=20' },
  dependencies: original.dependencies,
}, null, 2));
await cp(join(template, 'cloudbaserc.json'), join(output, 'cloudbaserc.json'));

// The Event runtime must receive node_modules; cloud install is disabled in
// cloudbaserc.json. Keeping the SDK's original files avoids bundler assumptions
// about lazy require calls and its transaction implementation.
const installed = await exec('npm', [
  'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
], { cwd: functionRoot, maxBuffer: 4 * 1024 * 1024 });
if (installed.stdout.trim()) console.log(installed.stdout.trim());
const sdk = JSON.parse(await readFile(join(functionRoot, 'node_modules/@cloudbase/node-sdk/package.json'), 'utf8'));
if (sdk.version !== original.dependencies['@cloudbase/node-sdk']) throw new Error('CloudBase SDK version does not match the pinned source dependency.');
await exec('zip', ['-q', '-r', join(output, `${functionName}.zip`), '.'], { cwd: functionRoot });
console.log(`Prepared ${output} (${sdk.name} ${sdk.version}). No login, deployment or database requests were made.`);
