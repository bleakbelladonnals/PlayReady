import { createRequire } from 'node:module';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ScfBrowserConfig {
  executablePath: string;
  args: string[];
  env: Record<string, string>;
}

/** The SCF code directory contains this package and the build-owned fonts/libs.
 * Keep Chromium external to esbuild: its Brotli paths are relative to its package. */
export async function browserConfig(): Promise<ScfBrowserConfig> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('SCF 自动试玩包需要 Linux x86_64，不能使用 Mac 或 ARM 的浏览器文件。');
  }
  const glibc = runtimeInfo().glibc;
  if (glibc && versionLessThan(glibc, '2.25')) {
    throw new Error(`SCF 系统 glibc ${glibc} 低于浏览器所需 2.25，请先核对 Node.js 20 的实际系统环境。`);
  }
  const packageRoot = process.cwd();
  const require = createRequire(join(packageRoot, 'package.json'));
  const chromium = require('@sparticuz/chromium') as {
    args: string[]; executablePath(): Promise<string>; setGraphicsMode: boolean;
  };
  chromium.setGraphicsMode = false; // Product scope is 2D Canvas, not WebGL.
  await stat(join(packageRoot, 'fonts/NotoSansCJKsc-Regular.otf'));
  await mkdir('/tmp/ludoready-font-cache', { recursive: true });
  const executablePath = await chromium.executablePath();
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.FONTCONFIG_PATH = join(packageRoot, 'fonts');
  env.FONTCONFIG_FILE = join(packageRoot, 'fonts/fonts.conf');
  // The supplied AL2023 NSS libraries require glibc >=2.34. Older systems must
  // use their installed NSS, not load incompatible libraries ahead of it.
  if (glibc && !versionLessThan(glibc, '2.34')) {
    env.LD_LIBRARY_PATH = [join(packageRoot, 'chromium-libs/lib'), '/tmp', env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  } else {
    env.LD_LIBRARY_PATH = ['/tmp', env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
  return { executablePath, args: safeChromiumArguments(chromium.args), env };
}

/** Preserve CSP/CORS and multiple BrowserContexts; Lambda's stock flags disable
 * web security and its single-process mode can close non-default contexts. */
export function safeChromiumArguments(args: readonly string[]): string[] {
  const removed = new Set(['--single-process', '--disable-web-security', '--allow-running-insecure-content', '--disable-site-isolation-trials']);
  const result = args.filter((arg) => !removed.has(arg)).flatMap((arg) => {
    if (!arg.startsWith('--disable-features=')) return [arg];
    const features = arg.slice('--disable-features='.length).split(',').filter((feature) => !['IsolateOrigins', 'site-per-process'].includes(feature));
    return features.length ? [`--disable-features=${features.join(',')}`] : [];
  });
  return [...result, '--disable-dev-shm-usage', '--mute-audio'];
}

/** No Qwen, project data or external website is used. The returned screenshot
 * lets the operator inspect Chinese glyphs and the real Canvas render. */
export async function probeBrowser() {
  const runtime = runtimeInfo();
  const launchOptions = await browserConfig();
  const require = createRequire(join(process.cwd(), 'package.json'));
  const { chromium } = require('playwright') as typeof import('playwright');
  const browser = await chromium.launch({ ...launchOptions, headless: true, timeout: 30_000 });
  try {
    const context = await browser.newContext({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.setContent('<style>body{background:#edf5f3;color:#183d34;font-family:sans-serif;margin:40px}h1{font-size:40px}</style><h1>森林金币乐园 · 中文画面</h1><canvas width="720" height="360"></canvas>');
    await page.evaluate(`(() => {
      const canvas = document.querySelector('canvas');
      const context = canvas.getContext('2d');
      context.fillStyle = '#74b78e'; context.fillRect(0, 0, 720, 360);
      context.fillStyle = '#ecbc38'; context.beginPath(); context.arc(360, 120, 42, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#32754f'; context.fillRect(310, 290, 100, 42);
    })()`);
    const png = await page.screenshot({ type: 'png' });
    const text = await page.locator('h1').innerText();
    await context.close();
    // Exercise another context in the same browser, as repairs do in production.
    const second = await browser.newContext();
    await second.newPage();
    await second.close();
    return { runtime, version: browser.version(), text, multipleContexts: true, pngBase64: png.toString('base64') };
  } finally { await browser.close(); }
}

export function runtimeInfo() {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return { node: process.version, platform: process.platform, arch: process.arch, glibc: report?.header?.glibcVersionRuntime ?? null };
}

function versionLessThan(left: string, right: string) {
  const [a, b] = left.split('.').map(Number);
  const [c, d] = right.split('.').map(Number);
  return a! < c! || (a === c && b! < d!);
}
