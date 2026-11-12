import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectZip } from './archive.js';
import { generateGame, type GeneratorConfig, type Progress } from './generator.js';
import { WebInputError, WebState, type Job } from './state.js';

type GameGenerator = (job: Job, config: GeneratorConfig, progress: Progress) => Promise<void>;
export interface WebServerOptions {
  dataDir: string;
  clientDir: string;
  publicOrigin: string;
  baseUrl: string;
  apiKey: string;
  generator?: GameGenerator;
}

const MAX_BODY_BYTES = 16 * 1024;
const SESSION_COOKIE = 'ludoready_session';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export async function createWebServer(options: WebServerOptions) {
  const state = new WebState(join(options.dataDir, 'state.json'));
  await state.init();
  const generator = options.generator ?? generateGame;
  let queue: Promise<void> = Promise.resolve();

  function enqueue(job: Job): void {
    queue = queue.then(async () => {
      await state.update(job.id, 'running', '准备制作', job.revision ? '已开始根据修改要求继续制作。' : '已开始制作你的 2D 网页游戏。');
      try {
        await generator(job, options, async (stage, message) => state.update(job.id, 'running', stage, message));
        await state.update(job.id, 'complete', '制作完成', job.revision ? '新版本已准备好，可以试玩和下载。' : '游戏已准备好，可以试玩和下载。');
      } catch (error) {
        const message = publicJobError(error);
        await state.update(job.id, 'failed', '制作中断', message, message);
        process.stderr.write(`[web-job ${job.id}] ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }).catch((error: unknown) => {
      process.stderr.write(`[web-queue] ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      const status = error instanceof WebInputError ? error.status : 500;
      const message = error instanceof WebInputError ? error.message : '服务暂时不可用，请稍后重试。';
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
      if (status === 500) process.stderr.write(`[web] ${error instanceof Error ? error.message : String(error)}\n`);
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'POST' && path === '/api/projects') {
        if (req.headers.origin && req.headers.origin !== options.publicOrigin) {
          throw new WebInputError(403, '请求来源无效。');
        }
        if (!options.apiKey || !options.baseUrl) throw new WebInputError(503, '创作服务尚未配置，请联系网站管理员。');
        const input = await readJsonBody(req);
        const { job, session } = await state.create(input.prompt);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/api/projects/${job.id}; Max-Age=2592000${options.publicOrigin.startsWith('https:') ? '; Secure' : ''}`);
        sendJson(res, 201, { id: job.id });
        enqueue(job);
        return;
      }
      const revisionMatch = /^\/api\/projects\/([a-f0-9-]{36})\/revise$/u.exec(path);
      if (req.method === 'POST' && revisionMatch) {
        if (req.headers.origin && req.headers.origin !== options.publicOrigin) throw new WebInputError(403, '请求来源无效。');
        if (!state.authorized(revisionMatch[1]!, readCookie(req.headers.cookie, SESSION_COOKIE))) {
          throw new WebInputError(404, '找不到这个项目，请在原浏览器中打开。');
        }
        if (!options.apiKey || !options.baseUrl) throw new WebInputError(503, '创作服务尚未配置，请联系网站管理员。');
        const input = await readJsonBody(req);
        const job = await state.revise(revisionMatch[1]!, readCookie(req.headers.cookie, SESSION_COOKIE), input.prompt);
        sendJson(res, 202, { id: job.id, revision: job.revision });
        enqueue(job);
        return;
      }
      const match = /^\/api\/projects\/([a-f0-9-]{36})(?:\/(download))?$/u.exec(path);
      if (req.method === 'GET' && match) {
        const job = state.authorized(match[1]!, readCookie(req.headers.cookie, SESSION_COOKIE));
        if (!job) throw new WebInputError(404, '找不到这个项目，请检查原浏览器中的项目链接。');
        if (match[2] === 'download') {
          if (!job.hasPublished) throw new WebInputError(409, '游戏尚未制作完成。');
          const bytes = await projectZip(join(options.dataDir, 'projects', job.id, 'public'));
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="playready-${job.id}.zip"`,
            'Content-Length': bytes.length,
            'Cache-Control': 'no-store',
          });
          res.end(bytes);
          return;
        }
        sendJson(res, 200, {
          id: job.id, prompt: job.prompt, status: job.status, stage: job.stage,
          error: job.error, events: job.events,
          revision: job.revision ?? 0, changePrompt: job.changePrompt ?? null, revisions: job.revisions ?? [],
          hasPublished: job.hasPublished ?? false, publishedRevision: job.publishedRevision ?? null,
          previewUrl: job.hasPublished ? `/play/${job.id}/${job.previewToken}/?v=${job.publishedRevision ?? 0}` : null,
          downloadUrl: job.hasPublished ? `/api/projects/${job.id}/download` : null,
        });
        return;
      }
      throw new WebInputError(404, '页面不存在。');
    }

    const play = /^\/play\/([a-f0-9-]{36})\/([A-Za-z0-9_-]{40,50})(?:\/(.*))?$/u.exec(path);
    if (req.method === 'GET' && play) {
      const job = state.preview(play[1]!, play[2]!);
      if (!job) throw new WebInputError(404, '试玩链接无效。');
      const requested = play[3] || 'index.html';
      if (!play[3] && !path.endsWith('/')) {
        res.writeHead(308, { Location: `${path}/` });
        res.end();
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (requested === 'index.html') {
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'");
      }
      await sendFile(res, join(options.dataDir, 'projects', job.id, 'public'), requested);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') throw new WebInputError(405, '不支持此请求。');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'");
    const requested = path === '/' || !extname(path) ? 'index.html' : path.slice(1);
    await sendFile(res, options.clientDir, requested);
  }

  return { server, state };
}

async function sendFile(res: ServerResponse, root: string, requested: string): Promise<void> {
  let decoded: string;
  try { decoded = decodeURIComponent(requested); }
  catch { throw new WebInputError(404, '文件不存在。'); }
  if (decoded.includes('\0') || decoded.split('/').some((part) => part === '..' || part === '.')) {
    throw new WebInputError(404, '文件不存在。');
  }
  const target = resolve(root, decoded);
  const inside = relative(resolve(root), target);
  if (isAbsolute(inside) || inside.startsWith('..') || inside.includes(`${sep}..${sep}`)) {
    throw new WebInputError(404, '文件不存在。');
  }
  let info;
  try { info = await lstat(target); }
  catch { throw new WebInputError(404, '文件不存在。'); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 40 * 1024 * 1024) {
    throw new WebInputError(404, '文件不存在。');
  }
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'no-store' });
  res.end(await readFile(target));
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length });
  res.end(bytes);
}

async function readJsonBody(req: IncomingMessage): Promise<{ prompt?: unknown }> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new WebInputError(415, '请使用 JSON 提交。');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new WebInputError(413, '提交内容过长。');
    chunks.push(bytes);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as { prompt?: unknown };
  } catch { throw new WebInputError(400, '提交格式无效。'); }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function publicJobError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/千问|图像|图片|游戏代码|语法检查|素材|审查|试玩检查|修复|规划/iu.test(message)) return message.slice(0, 180);
  return '制作过程中遇到问题，请联系网站管理员并提供项目编号。';
}

export async function startWebServer(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(process.env.WEB_DATA_DIR || '.ludoready-web');
  const clientDir = resolve(here, '../../../dist/web-client');
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const publicOrigin = process.env.WEB_PUBLIC_ORIGIN || `http://${host}:${port}`;
  const baseUrl = (process.env.DASHSCOPE_BASE_URL || '').replace(/\/+$/u, '');
  if (!process.env.DASHSCOPE_API_KEY || !baseUrl) {
    throw new Error('百炼配置缺失：请先运行 npm run web:setup，再运行 npm run web:serve');
  }
  const providerUrl = baseUrl ? new URL(baseUrl) : null;
  if (providerUrl && ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(providerUrl.hostname)) {
    throw new Error('千问图片 3.0 在当前配置的通用地址返回 404。请运行 npm run web:workspace -- 你的WorkspaceId 更新业务空间地址。');
  }
  if (providerUrl && (providerUrl.protocol !== 'https:'
    || providerUrl.port || providerUrl.pathname !== '/compatible-mode/v1'
    || providerUrl.search || providerUrl.hash
    || !(providerUrl.hostname === 'dashscope.aliyuncs.com'
      || providerUrl.hostname === 'dashscope-intl.aliyuncs.com'
      || /^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/u.test(providerUrl.hostname)))) {
    throw new Error('DASHSCOPE_BASE_URL must be an HTTPS Alibaba compatible-mode/v1 base URL');
  }
  const { server } = await createWebServer({
    dataDir, clientDir, publicOrigin, baseUrl,
    apiKey: process.env.DASHSCOPE_API_KEY || '',
  });
  server.listen(port, host, () => process.stdout.write(`PlayReady Web listening on ${host}:${port}\n`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startWebServer().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
