import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'src/showcases/opus');
const destination = resolve(root, 'src/renderer/public/showcases/opus');

await mkdir(destination, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: [resolve(source, 'src/main.js')],
  outfile: resolve(destination, 'app.js'),
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: true,
  legalComments: 'eof',
  logLevel: 'warning',
});

const [template, bundledScript] = await Promise.all([
  readFile(resolve(source, 'index.template.html'), 'utf8'),
  readFile(resolve(destination, 'app.js'), 'utf8'),
]);
// Keep the template's inline CSS and make the IIFE independent of file:// loading.
const script = bundledScript.replace(/<\/script/giu, (match) => '<\\/' + match.slice(2));
const html = template
  .replace('<!--OG_IMAGE-->', '')
  .replace(/<script>\s*\/\*APP_JS\*\/\s*<\/script>/u, () => `<script>${script}</script>`);
await writeFile(resolve(destination, 'index.html'), html);
await copyFile(resolve(source, 'SOURCE.md'), resolve(destination, 'SOURCE.md'));
await copyFile(resolve(source, 'cover.png'), resolve(destination, 'cover.png'));
await copyFile(resolve(source, 'THIRD_PARTY_NOTICES.txt'), resolve(destination, 'THIRD_PARTY_NOTICES.txt'));
await copyFile(resolve(source, 'package.json'), resolve(destination, 'upstream-package.json'));
console.log('Opus showcase built: src/renderer/public/showcases/opus/index.html');
