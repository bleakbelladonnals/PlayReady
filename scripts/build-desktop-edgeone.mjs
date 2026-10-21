import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'dist/desktop-edgeone');
let previewOrigin = '';
if (process.env.LUDOREADY_DESKTOP_PREVIEW_ORIGIN) {
  const candidate = new URL(process.env.LUDOREADY_DESKTOP_PREVIEW_ORIGIN);
  if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.pathname !== '/' || candidate.search || candidate.hash) throw new Error('Desktop preview origin must be an HTTPS origin.');
  previewOrigin = candidate.origin;
}
await readFile(join(root, 'dist/renderer/index.html'));
await rm(output, { recursive: true, force: true });
await cp(join(root, 'dist/renderer'), output, { recursive: true });
await build({ entryPoints: [join(root, 'src/web/desktopRelay/previewEdge.ts')], outfile: join(output, 'edge-functions/desktop/preview/[[...path]].js'), bundle: true, platform: 'neutral', format: 'esm', target: 'es2022' });
await build({ entryPoints: [join(root, 'src/web/desktopRelay/middleware.ts')], outfile: join(output, 'middleware.js'), bundle: true, platform: 'neutral', format: 'esm', target: 'es2022' });
await build({ entryPoints: [join(root, 'src/web/desktopRelay/handler.ts')], outfile: join(output, 'cloud-functions/_handler.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node20' });
for (const route of ['desktop/[[...path]]', 'api/projects', 'api/projects/[[...path]]', 'api/worker/storage', 'produce', 'play/[[...path]]']) {
  const path = join(output, 'cloud-functions', `${route}.ts`);
  await mkdir(dirname(path), { recursive: true });
  const levels = route.split('/').length - 1;
  await writeFile(path, `import { desktopCloudHandler } from '${levels ? '../'.repeat(levels) : './'}_handler.mjs';\nexport async function onRequest(context) { return desktopCloudHandler(context); }\n`);
}
await writeFile(join(output, 'package.json'), JSON.stringify({ name: 'ludoready-desktop-web', private: true, type: 'module', engines: { node: '>=20' } }, null, 2));
const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'${previewOrigin ? ` ${previewOrigin}` : ''}; object-src 'none'; base-uri 'self'; form-action 'self'`;
const rendererIndex = join(output, 'index.html');
const rendererHtml = await readFile(rendererIndex, 'utf8');
await writeFile(rendererIndex, rendererHtml.replace(
  /<meta\b(?=[^>]*\bhttp-equiv=["']Content-Security-Policy["'])[^>]*>/iu,
  `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
));
await writeFile(join(output, 'edgeone.json'), JSON.stringify({
  headers: [
    { source: '/*', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'no-referrer' }] },
    ...['/', '/index.html'].map((source) => ({ source, headers: [{ key: 'Content-Security-Policy', value: csp }, { key: 'X-Frame-Options', value: 'DENY' }] })),
  ],
}, null, 2));
console.log(`Prepared ${output}; local credentials and projects are excluded.`);
