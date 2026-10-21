import { extname } from 'node:path';
import type { CloudFunctionContext } from '@edgeone/types';
import { getStore } from '@edgeone/pages-blob';
import { WebInputError } from '../server/state.js';
import { publicError, readSession, requireOrigin, requireProvider, sessionCookie, stateCall, type CloudJob } from './rpc.js';
import { storageHandler } from './storage.js';

const gameCsp = "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8' };
export function fileType(path: string): string { return types[extname(path)] ?? 'application/octet-stream'; }

export async function cloudHandler(context: CloudFunctionContext): Promise<Response> {
  const request = context.request;
  if (!request) return json({ error: '页面不存在。' }, 404);
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/api/worker/storage') return await storageHandler(context);
    if (request.method === 'POST') requireOrigin(request.headers.get('origin'), context.env);
    if (request.method === 'POST' && path === '/produce') {
      const body = await request.body as { id?: unknown; revision?: unknown };
      if (typeof body?.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(body.id) || !Number.isSafeInteger(body.revision)) throw new WebInputError(400, '项目编号或版本无效。');
      const { job } = await stateCall<{ job: CloudJob | null }>(context.env, 'authorized', {
        id: body.id, session: readSession(request.headers.get('cookie'), body.id),
      });
      if (!job) throw new WebInputError(404, '找不到这个项目，请在原浏览器中打开。');
      if (job.revision !== body.revision) throw new WebInputError(409, '项目版本已更新。');
      if (!context.env.LUDO_WORKER_URL || !context.env.LUDO_WORKER_SECRET) throw new WebInputError(503, '制作服务尚未配置。');
      if (job.status === 'queued') {
        const wake = await fetch(context.env.LUDO_WORKER_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${context.env.LUDO_WORKER_SECRET}` },
          body: JSON.stringify({ op: 'wake' }), signal: AbortSignal.timeout(15_000), redirect: 'error',
        });
        if (!wake.ok) throw new WebInputError(503, '制作服务暂时不可用，项目已保存。');
      }
      return new Response('data: {"queued":true}\n\n', { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (request.method === 'POST' && path === '/api/projects') {
      requireProvider(context.env);
      const body = await request.body as { prompt?: unknown };
      const { job, session } = await stateCall<{ job: CloudJob; session: string }>(context.env, 'create', { prompt: body?.prompt });
      return json({ id: job.id, run: runDescriptor(job) }, 201, {
        'Set-Cookie': `${sessionCookie(job.id)}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000; Secure`,
      });
    }
    const api = /^\/api\/projects\/([a-f0-9-]{36})(?:\/(revise|download|diagnostics)(?:\/(\d+))?)?$/u.exec(path);
    if (api) {
      const id = api[1]!;
      const session = readSession(request.headers.get('cookie'), id);
      if (request.method === 'POST' && api[2] === 'revise') {
        requireProvider(context.env);
        const body = await request.body as { prompt?: unknown };
        const { job } = await stateCall<{ job: CloudJob }>(context.env, 'revise', { id, session, prompt: body?.prompt });
        return json({ id, revision: job.revision, run: runDescriptor(job) }, 202);
      }
      if (request.method !== 'GET') throw new WebInputError(405, '不支持此请求。');
      const { job } = await stateCall<{ job: CloudJob | null }>(context.env, 'authorized', { id, session });
      if (!job) throw new WebInputError(404, '找不到这个项目，请在原浏览器中打开。');
      if (api[2] === 'diagnostics') {
        const key = job.draftSourceKey ?? job.publication?.sourceKey;
        if (!key) return json({ revision: job.revision ?? 0, history: [], playtest: null });
        const blob = getStore('ludoready-projects');
        const source = await blob.get(key, { type: 'json', consistency: 'strong' }) as { revision?: number; files: Array<{ path: string; key: string }> } | null;
        if (!source) throw new WebInputError(404, '制作记录不存在。');
        async function readDiagnostic(path: string) {
          const file = source!.files.find((entry) => entry.path === path);
          return file ? await blob.get(file.key, { type: 'json', consistency: 'strong' }) : null;
        }
        const [history, playtest, productionError] = await Promise.all([readDiagnostic('production-history.json'), readDiagnostic('artifacts/playtest/latest/report.json'), readDiagnostic('production-error.json')]);
        return json({ revision: source.revision ?? job.publishedRevision, history: history ?? [], playtest, productionError });
      }
      if (api[2] === 'download') {
        const publication = job.publication;
        if (!job.hasPublished || !publication) throw new WebInputError(409, '游戏尚未制作完成。');
        const filename = `ludoready-${id}.zip`;
        if (!api[3] && publication.archiveKeys.length > 1) return json({ filename, chunks: publication.archiveKeys.map((chunk, index) => ({ url: `/api/projects/${id}/download/${index}?v=${job.publishedRevision}`, size: chunk.size })) });
        const index = api[3] ? Number(api[3]) : 0;
        const chunk = publication.archiveKeys[index];
        if (!chunk || (api[3] && url.searchParams.get('v') !== String(job.publishedRevision))) throw new WebInputError(409, '游戏版本已更新，请重新下载。');
        const bytes = await getStore('ludoready-projects').get(chunk.key, { type: 'arrayBuffer', consistency: 'strong' }) as ArrayBuffer | null;
        if (!bytes) throw new WebInputError(404, '游戏文件不存在。');
        return new Response(bytes, { headers: { 'Content-Type': api[3] ? 'application/octet-stream' : 'application/zip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' } });
      }
      return json({
        id: job.id, prompt: job.prompt, status: job.status, stage: job.stage, error: job.error, events: job.events,
        revision: job.revision, changePrompt: job.changePrompt, revisions: job.revisions,
        hasPublished: job.hasPublished, publishedRevision: job.publishedRevision,
        previewUrl: job.hasPublished ? `/play/${id}/${job.previewToken}/?v=${job.publishedRevision}` : null,
        downloadUrl: job.hasPublished ? `/api/projects/${id}/download` : null,
        ...(job.status === 'queued' ? { run: runDescriptor(job) } : {}),
      });
    }
    const play = /^\/play\/([a-f0-9-]{36})\/([A-Za-z0-9_-]{43})(?:\/(.*))?$/u.exec(path);
    if (play && ['GET', 'HEAD'].includes(request.method)) {
      const { job } = await stateCall<{ job: CloudJob | null }>(context.env, 'preview', { id: play[1], token: play[2] });
      if (!job?.publication) throw new WebInputError(404, '试玩链接无效。');
      if (!play[3] && !path.endsWith('/')) return Response.redirect(`${url.origin}${path}/${url.search}`, 308);
      let requested: string;
      try { requested = decodeURIComponent(play[3] || 'index.html'); } catch { throw new WebInputError(404, '文件不存在。'); }
      if (requested.includes('\0') || requested.split('/').some((part) => part === '..' || part === '.')) throw new WebInputError(404, '文件不存在。');
      const file = job.publication.files.find((entry) => entry.path === requested);
      if (!file) throw new WebInputError(404, '文件不存在。');
      const bytes = request.method === 'HEAD' ? null : await getStore('ludoready-projects').get(file.key, { type: 'arrayBuffer', consistency: 'strong' }) as ArrayBuffer | null;
      if (request.method !== 'HEAD' && !bytes) throw new WebInputError(404, '文件不存在。');
      return new Response(bytes, { headers: {
        'Content-Type': file.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
        ...(requested === 'index.html' ? { 'Content-Security-Policy': gameCsp } : {}),
      } });
    }
    throw new WebInputError(404, '页面不存在。');
  } catch (error) { const failure = publicError(error); return json({ error: failure.error }, failure.status); }
}

function runDescriptor(job: CloudJob) { return { url: '/produce', id: job.id, revision: job.revision ?? 0 }; }
function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}
