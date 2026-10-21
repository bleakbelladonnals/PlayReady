import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'src/showcases/astra');
const output = path.join(root, 'src/renderer/public/showcases/astra');
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: [path.join(source, 'src/main.js')],
  outfile: path.join(output, 'showcase.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'linked',
  logLevel: 'info',
});
const [template, bundledScript, bundledStyle] = await Promise.all([
  readFile(path.join(source, 'index.html'), 'utf8'),
  readFile(path.join(output, 'showcase.js'), 'utf8'),
  readFile(path.join(output, 'showcase.css'), 'utf8'),
]);
// Inline resources also run inside a sandboxed file:// iframe with an opaque origin.
const script = bundledScript.replace(/<\/script/giu, (match) => '<\\/' + match.slice(2));
const style = bundledStyle.replace(/<\/style/giu, (match) => '<\\/' + match.slice(2));
const html = template
  .replace('<link rel="stylesheet" href="./showcase.css">', () => `<style>${style}</style>`)
  .replace('<script defer src="./showcase.js"></script>', () => `<script>${script}</script>`);
await writeFile(path.join(output, 'index.html'), html);
for (const name of ['LICENSE', 'PROVENANCE.json', 'SOURCE.md', 'cover.png']) {
  await copyFile(path.join(source, name), path.join(output, name));
}
await copyFile(path.join(root, 'node_modules/three/LICENSE'), path.join(output, 'THREE-LICENSE.txt'));
