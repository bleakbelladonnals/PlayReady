import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'dist/edgeone');
await readFile(join(root, 'dist/web-client/index.html'));
await rm(output, { recursive: true, force: true });
await cp(join(root, 'dist/web-client'), output, { recursive: true });
// Production and Chromium run in SCF. EdgeOne serves the site, authenticated
// project APIs and private object storage callbacks, without Agents/Sandbox.
await build({ entryPoints: [join(root, 'src/web/edgeone/handler.ts')], outfile: join(output, 'cloud-functions/_handler.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node20' });
for (const route of ['api/projects', 'api/projects/[[...path]]', 'api/worker/storage', 'produce', 'play/[[...path]]']) {
  const path = join(output, 'cloud-functions', `${route}.ts`);
  await mkdir(dirname(path), { recursive: true });
  const levels = route.split('/').length - 1;
  await writeFile(path, `import { cloudHandler } from '${levels ? '../'.repeat(levels) : './'}_handler.mjs';\nexport async function onRequest(context: any) { return cloudHandler(context); }\n`);
}
await writeFile(join(output, 'package.json'), JSON.stringify({ name: 'ludoready-web', private: true, type: 'module', engines: { node: '>=20' } }, null, 2));
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'";
await writeFile(join(output, 'edgeone.json'), JSON.stringify({
  headers: [
    { source: '/*', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'no-referrer' }] },
    ...['/', '/index.html'].map((source) => ({ source, headers: [{ key: 'Content-Security-Policy', value: csp }, { key: 'X-Frame-Options', value: 'DENY' }] })),
  ],
}, null, 2));
console.log(`Prepared ${output}; no local credentials or user projects are included.`);
