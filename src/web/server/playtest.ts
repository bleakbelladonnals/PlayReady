import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent } from 'electron';
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright';
import { PNG } from 'pngjs';
import {
  GameplayExperienceEvaluator,
  type GameplayBrowserWindow,
  type GameplayCapturedImage,
  type GameplayExperienceReport,
  type GameplayWebContents,
} from '../../main/gameplayExperienceEvaluator.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

interface ImageProportionViolation {
  asset: string;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  scaleX: number;
  scaleY: number;
  error: number;
}

/** Uses the desktop evaluator unchanged; generated files never become host commands. */
export async function runWebPlaytest(projectRoot: string, options: { cdpUrl?: string; launchOptions?: LaunchOptions } = {}): Promise<GameplayExperienceReport> {
  const root = await realpath(projectRoot);
  const publicRoot = await realpath(join(root, 'public'));
  if (!isWithin(root, publicRoot)) throw new Error('游戏 public 目录不能指向项目外部');
  const server = createStaticServer(publicRoot);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法启动游戏试玩服务');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      browser = options.cdpUrl
        ? await chromium.connectOverCDP(options.cdpUrl, { timeout: 30_000, headers: managedBrowserHeaders(options.cdpUrl) })
        : await chromium.launch({ headless: true, timeout: 30_000, ...options.launchOptions, args: [...(options.launchOptions?.args ?? []), '--mute-audio'] });
    } catch (error) {
      if (/executable doesn't exist|browser.*not found|playwright install/i.test(String(error))) {
        throw new Error('自动试玩所需的 Chromium 尚未安装，请在服务器执行 npm run web:install-browser。');
      }
      throw new Error('自动试玩浏览器无法启动，请检查 Chromium 运行依赖和服务器可用内存。', { cause: error });
    }
    context = await browser.newContext({
      viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1,
      // The preview CSP sandbox already disallows Service Workers. Playwright's
      // serviceWorkers:'block' injected probe throws in that opaque origin.
      acceptDownloads: false,
    });
    // Route at context level so popups and child frames receive the same boundary.
    await context.route('**/*', async (route) => {
      const request = route.request();
      let allowed = false;
      try {
        const url = new URL(request.url());
        allowed = url.protocol === 'http:' && url.origin === origin
          && !url.username && !url.password && ['GET', 'HEAD'].includes(request.method());
      } catch { /* Invalid and non-HTTP resources cannot leave the browser. */ }
      if (!allowed) await route.abort('blockedbyclient');
      else if (options.cdpUrl) {
        // The managed browser runs separately from the Agent's loopback server.
        // Relay only this exact game's GET/HEAD requests through the host.
        try {
          const response = await fetch(request.url(), { method: request.method(), redirect: 'error' });
          await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
        } catch { await route.abort('failed'); }
      } else await route.continue();
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    const page = await context.newPage();
    const proportions = await observeImageProportions(page);
    context.on('page', (popup) => {
      if (popup !== page) void popup.close().catch(() => undefined);
    });
    const window = new PlaywrightGameWindow(page);
    const evaluator = new GameplayExperienceEvaluator({ createWindow: () => window });
    const report = await evaluator.evaluate({
      projectRoot: root, previewUrl: `${origin}/index.html`,
      expectedEngine: 'web', expectedEntrypoint: 'public/index.html',
    });
    if (proportions.length) {
      applyImageProportionFindings(report, proportions);
      await writeHostReport(root, report);
    }
    return report;
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** EdgeOne's Sandbox toolkit supplies the same token on CDP's WebSocket upgrade. */
function managedBrowserHeaders(cdpUrl: string): Record<string, string> | undefined {
  const token = new URL(cdpUrl).searchParams.get('access_token');
  return token ? { 'X-Access-Token': token } : undefined;
}

/** Observe successful native image draws without changing their arguments,
 * pixels, input handling or simulation. Geometric drawing is unaffected. */
async function observeImageProportions(page: Page): Promise<ImageProportionViolation[]> {
  const violations: ImageProportionViolation[] = [];
  const binding = `__ludoreadyImageProportions${randomUUID().replaceAll('-', '')}`;
  await page.exposeBinding(binding, (_source, value: ImageProportionViolation) => {
    if (violations.length < 20) violations.push(value);
  });
  await page.addInitScript({ content: `(() => {
    const original = CanvasRenderingContext2D.prototype.drawImage;
    const seen = new Set();
    const notify = window[${JSON.stringify(binding)}];
    CanvasRenderingContext2D.prototype.drawImage = function(...args) {
      const result = original.apply(this, args);
      const image = args[0];
      if (!(image instanceof HTMLImageElement) || (args.length !== 5 && args.length !== 9)) return result;
      const sourceWidth = Math.abs(args.length === 9 ? Number(args[3]) : image.naturalWidth);
      const sourceHeight = Math.abs(args.length === 9 ? Number(args[4]) : image.naturalHeight);
      const targetWidth = Math.abs(Number(args[args.length - 2]));
      const targetHeight = Math.abs(Number(args[args.length - 1]));
      const transform = this.getTransform();
      const scaleX = Math.hypot(transform.a, transform.b);
      const scaleY = Math.hypot(transform.c, transform.d);
      if (![sourceWidth, sourceHeight, targetWidth, targetHeight, scaleX, scaleY].every(n => Number.isFinite(n) && n > 0)) return result;
      const error = Math.abs((targetWidth * scaleX / (targetHeight * scaleY)) / (sourceWidth / sourceHeight) - 1);
      if (error <= 0.05 || seen.size >= 20) return result;
      const url = new URL(image.currentSrc || image.src, location.href);
      const asset = url.protocol === 'data:' ? '<data-image>' : url.pathname.split('/').pop().slice(0, 180);
      const finding = { asset, sourceWidth, sourceHeight, targetWidth, targetHeight, scaleX, scaleY, error };
      const key = JSON.stringify(finding);
      if (!seen.has(key)) {
        seen.add(key);
        void notify(finding).catch(() => {});
      }
      return result;
    };
  })()` });
  return violations;
}

function applyImageProportionFindings(
  report: GameplayExperienceReport,
  violations: readonly ImageProportionViolation[],
): void {
  const number = (value: number) => String(Math.round(value * 100) / 100);
  const details = violations.slice(0, 3).map((item) => {
    const proportionalWidth = item.targetHeight * item.scaleY * item.sourceWidth / (item.sourceHeight * item.scaleX);
    const proportionalHeight = item.targetWidth * item.scaleX * item.sourceHeight / (item.sourceWidth * item.scaleY);
    return `${item.asset}：源 ${number(item.sourceWidth)}×${number(item.sourceHeight)} → 目标 ${number(item.targetWidth)}×${number(item.targetHeight)}，绘图缩放 ${number(item.scaleX)}×${number(item.scaleY)}，比例偏差 ${number(item.error * 100)}%；建议宽 ${number(proportionalWidth)} 或高 ${number(proportionalHeight)}，另一边保持当前尺寸。`;
  });
  const check = report.checks.find((item) => item.id === 'visible-surface');
  if (!check) throw new Error('宿主试玩报告缺少可见画面检查');
  check.status = 'repair';
  check.message = `实际图片绘制发生拉伸。${details.join(' ')}${violations.length > 3 ? ` 另有 ${violations.length - 3} 处。` : ''}`.slice(0, 500);
  report.verdict = 'repair';
  const applicable = report.checks.filter((item) => item.status !== 'skipped');
  report.score = Math.min(99, Math.round(applicable.filter((item) => item.status === 'pass').length / applicable.length * 100));
  report.summary = `体验评测发现 ${report.checks.filter((item) => item.status === 'repair').length} 项需要修复，实际图片比例检查发现拉伸。`;
}

async function writeHostReport(root: string, report: GameplayExperienceReport): Promise<void> {
  // Amend the already-published host report through its regular, unlinked file.
  // Keep the same six check ids and make persisted evidence match the return value.
  const path = join(root, report.reportPath);
  const file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || await realpath(path) !== path) {
      throw new Error('无法安全更新宿主试玩报告');
    }
    await file.truncate(0);
    await file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await file.close(); }
}

function createStaticServer(publicRoot: string): Server {
  return createServer((request, response) => {
    void (async () => {
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        response.writeHead(405).end();
        return;
      }
      let path: string;
      try {
        path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (path.includes('\0') || path.split('/').some((part) => part.startsWith('.'))) {
        response.writeHead(403).end();
        return;
      }
      const target = await realpath(join(publicRoot, path === '/' ? 'index.html' : path));
      if (!isWithin(publicRoot, target) || !(await stat(target)).isFile()) {
        response.writeHead(403).end();
        return;
      }
      const bytes = await readFile(target);
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        ...(target === join(publicRoot, 'index.html') ? {
          // Keep the generated-game policy identical to the public preview.
          'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'",
        } : {}),
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    });
  });
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function decodeCapture(bytes: Buffer): GameplayCapturedImage {
  const png = PNG.sync.read(bytes);
  const bitmap = Buffer.from(png.data);
  // Electron NativeImage exposes BGRA; preserve the evaluator's pixel format.
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    const red = bitmap[offset];
    bitmap[offset] = bitmap[offset + 2];
    bitmap[offset + 2] = red;
  }
  return {
    getSize: () => ({ width: png.width, height: png.height }),
    toBitmap: () => Buffer.from(bitmap),
    toPNG: () => bytes,
  };
}

class PlaywrightGameWindow extends EventEmitter implements GameplayBrowserWindow {
  readonly webContents: PlaywrightGameContents;
  #destroyed = false;

  constructor(readonly page: Page) {
    super();
    this.webContents = new PlaywrightGameContents(page);
    page.on('crash', () => this.webContents.emit('render-process-gone', {}, { reason: 'crashed' }));
    page.on('close', () => { this.#destroyed = true; });
  }

  async loadURL(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  }

  isDestroyed(): boolean { return this.#destroyed || this.page.isClosed(); }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    void this.page.close().catch(() => undefined);
  }
}

class PlaywrightGameContents extends EventEmitter implements GameplayWebContents {
  #inputs = Promise.resolve();
  #inputError: unknown;

  constructor(readonly page: Page) {
    super();
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const location = message.location();
      this.emit('console-message', {}, 3, message.text(), location.lineNumber + 1, location.url);
    });
    page.on('pageerror', (error) => this.emit('console-message', {}, 3, error.message, 0, page.url()));
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
    page.on('download', (download) => void download.cancel().catch(() => undefined));
  }

  // Context routing and popup handling are installed before this adapter is used.
  setWindowOpenHandler(_handler: (details: { url: string }) => { action: 'deny' }): void {}

  async executeJavaScript<T>(code: string): Promise<T> {
    await this.#flushInputs();
    return this.page.evaluate(code) as Promise<T>;
  }

  async capturePage(): Promise<GameplayCapturedImage> {
    await this.#flushInputs();
    return decodeCapture(await this.page.screenshot({ type: 'png', timeout: 10_000 }));
  }

  sendInputEvent(event: KeyboardInputEvent | MouseInputEvent | MouseWheelInputEvent): void {
    this.#inputs = this.#inputs.then(async () => {
      if (this.page.isClosed()) return;
      if (event.type === 'keyDown' || event.type === 'keyUp') {
        const key = playwrightKey(event.keyCode);
        if (event.type === 'keyDown') await this.page.keyboard.down(key);
        else await this.page.keyboard.up(key);
      } else if (event.type === 'mouseMove' || event.type === 'mouseDown' || event.type === 'mouseUp') {
        await this.page.mouse.move(event.x, event.y);
        if (event.type === 'mouseDown') await this.page.mouse.down({ button: event.button ?? 'left' });
        if (event.type === 'mouseUp') await this.page.mouse.up({ button: event.button ?? 'left' });
      } else if (event.type === 'mouseWheel') {
        const wheel = event as MouseWheelInputEvent;
        await this.page.mouse.wheel(wheel.deltaX ?? 0, wheel.deltaY ?? 0);
      }
    }).catch((error: unknown) => { this.#inputError = error; });
  }

  async #flushInputs(): Promise<void> {
    await this.#inputs;
    if (this.#inputError) throw this.#inputError;
  }
}

function playwrightKey(key: string): string {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  return ({ Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' } as Record<string, string>)[key] ?? key;
}
