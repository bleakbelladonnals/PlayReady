import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { build } from 'esbuild';

// Build only. Never reads local credentials, deploys, invokes SCF, or calls Qwen.
const root = resolve(import.meta.dirname, '..');
const probeOnly = process.argv.includes('--probe-only');
assert(process.argv.slice(2).every((arg) => arg === '--probe-only'), 'Supported option: --probe-only');
const output = join(root, 'dist', probeOnly ? 'scf-browser-probe' : 'scf-worker');
const cache = join(root, '.ludoready-private/scf-build-cache');
const chromiumVersion = '143.0.4'; // Last selected version with an explicit Node20 engine range.
const fontUrl = 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf';
const fontSha256 = '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b';
const entry = join(root, 'src/web/scf/index.ts');
if (!probeOnly) await stat(entry);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(cache, { recursive: true, mode: 0o700 });
const playwrightVersion = JSON.parse(await readFile(join(root, 'node_modules/playwright/package.json'), 'utf8')).version;
await writeFile(join(output, 'package.json'), JSON.stringify({
  name: 'ludoready-scf-worker', private: true, type: 'commonjs', engines: { node: '>=20.19.0' },
  dependencies: { '@sparticuz/chromium': chromiumVersion, playwright: playwrightVersion },
}, null, 2));
run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], {
  cwd: output, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
});
const fonts = join(output, 'fonts');
await mkdir(fonts);
let font;
const fontCache = join(cache, 'NotoSansCJKsc-Regular.otf');
try { font = await readFile(fontCache); } catch { font = await download(fontUrl); await writeFile(fontCache, font); }
assert(hash(font) === fontSha256, 'Chinese font hash differs from the inspected Sans2.004 release');
await writeFile(join(fonts, 'NotoSansCJKsc-Regular.otf'), font);
const licenseCache = join(cache, 'Noto-OFL.txt');
let license;
try { license = await readFile(licenseCache); } catch {
  license = await download('https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/LICENSE');
  await writeFile(licenseCache, license);
}
await writeFile(join(fonts, 'OFL.txt'), license);
await writeFile(join(fonts, 'fonts.conf'), '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir prefix="relative">.</dir><dir>/tmp/fonts</dir><cachedir>/tmp/ludoready-font-cache</cachedir><alias><family>sans-serif</family><prefer><family>Noto Sans CJK SC</family></prefer></alias></fontconfig>\n');

// SCF does not set AWS_EXECUTION_ENV, so the package will not unpack its NSS
// libraries automatically. Extract them at build time; use only when ABI fits.
const libs = join(output, 'chromium-libs');
await mkdir(libs);
const libraryTar = join(cache, 'al2023.tar');
await writeFile(libraryTar, brotliDecompressSync(await readFile(join(output, 'node_modules/@sparticuz/chromium/bin/al2023.tar.br'))));
run('tar', ['-xf', libraryTar, '-C', libs]);

let source = entry;
if (probeOnly) {
  source = join(output, '_probe-entry.ts');
  await writeFile(source, `import {probeBrowser,runtimeInfo} from ${JSON.stringify(join(root, 'src/web/scf/browser.ts'))};\nexport async function main_handler(event){try{return event?.type==='runtime'?runtimeInfo():await probeBrowser();}catch(error){return {runtime:runtimeInfo(),error:String(error?.message||error).slice(0,4000)};}}\n`);
}
await build({ entryPoints: [source], outfile: join(output, 'index.js'), bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['playwright', 'playwright-core', '@sparticuz/chromium'], metafile: true });
if (probeOnly) await rm(source);

const binary = brotliDecompressSync(await readFile(join(output, 'node_modules/@sparticuz/chromium/bin/chromium.br')));
assert(binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && binary.readUInt16LE(18) === 62, 'Chromium is not Linux x86_64 ELF');
const glibc = [...new Set(binary.toString('latin1').match(/GLIBC_\d+\.\d+(?:\.\d+)?/g))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
const manifest = {
  nodeRuntime: 'Nodejs20.19', handler: 'index.main_handler', architecture: 'x86_64',
  chromium: chromiumVersion, playwright: playwrightVersion,
  executableBytes: binary.length, executableSha256: hash(binary), requiredGlibc: glibc,
  bundledNssRequiredGlibc: 'GLIBC_2.34', fontSha256, probeOnly,
  sources: ['https://cloud.tencent.com/document/product/583/11060', 'https://cloud.tencent.com/document/product/583/73923', 'https://github.com/Sparticuz/chromium', fontUrl],
};
await writeFile(join(output, 'build-manifest.json'), JSON.stringify(manifest, null, 2));
const unpackedBytes = await directorySize(output);
assert(unpackedBytes < 500 * 1024 * 1024, 'SCF code package exceeds the official 500MB unpacked limit');
const zip = `${output}.zip`;
await rm(zip, { force: true });
run('zip', ['-q', '-r', zip, '.'], { cwd: output });
const zipBytes = (await stat(zip)).size;
console.log(JSON.stringify({ output, zip, unpackedBytes, zipBytes, uploadViaCos: zipBytes >= 50 * 1024 * 1024, ...manifest }, null, 2));
console.log('Local build only. Deploy the probe and confirm Linux/glibc, Chinese screenshot, BrowserContexts and real host checks before any paid production.');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  assert(result.status === 0, `${command} failed with status ${result.status}`);
}
async function download(url) {
  // curl honors the developer machine's HTTPS proxy; native fetch timed out
  // against this verified public font URL in the actual build environment.
  const result = spawnSync('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '120', url], { maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert(result.status === 0, `Public build dependency download failed: ${result.stderr.toString().slice(0, 500)}`);
  return result.stdout;
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function directorySize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}
