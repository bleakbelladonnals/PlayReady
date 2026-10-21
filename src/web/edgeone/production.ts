import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentContext } from '@edgeone/types';
import { getStore } from '@edgeone/pages-blob';
import { generateGame } from '../server/generator.js';
import { runWebPlaytest } from '../server/playtest.js';
import { projectZip } from '../server/archive.js';
import { WebInputError } from '../server/state.js';
import { fileType } from './handler.js';
import { publicError, readSession, requireOrigin, requireProvider, stateCall, type CloudJob, type Publication } from './rpc.js';

const CHUNK_SIZE = 4 * 1024 * 1024;
type SavedFile = { path: string; key: string; size: number };

export async function productionHandler(context: AgentContext): Promise<Response> {
  try {
    if (context.request.method !== 'POST') throw new WebInputError(405, '不支持此请求。');
    requireOrigin(context.request.headers.origin, context.env);
    requireProvider(context.env);
    const body = context.request.body as { id?: unknown; revision?: unknown };
    if (typeof body?.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(body.id) || !Number.isInteger(body.revision) || Number(body.revision) < 0
      || context.conversation_id !== body.id) throw new WebInputError(400, '项目编号或版本无效。');
    const runId = randomUUID();
    const { claimed, job } = await stateCall<{ claimed: boolean; job?: CloudJob }>(context.env, 'claim', {
      id: body.id, revision: body.revision, runId, session: readSession(context.request.headers.cookie, body.id),
    });
    if (!claimed || !job) return Response.json({ started: false }, { status: 200 });
    // The task owns its lifecycle. Closing the page stops delivery of heartbeat
    // messages, while persisted status continues to record the production work.
    let connected = true;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (value: unknown) => { if (connected) { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); } catch { connected = false; } } };
        const heartbeat = setInterval(() => send({ active: true }), 10_000);
        const update = (status: string, stage: string, message: string, extra: Record<string, unknown> = {}) => stateCall(context.env, 'update', { id: job.id, revision: job.revision ?? 0, runId, status, stage, message, ...extra });
        let root: string | undefined;
        let sandboxInitialized = false;
        let phase = '浏览器准备';
        try {
          send({ started: true });
          root = await mkdtemp(join(tmpdir(), 'ludoready-production-'));
          if (!context.sandbox) throw new Error('托管浏览器不可用。');
          await context.sandbox.commands.run('true', { timeout: 30 });
          sandboxInitialized = true;
          const cdpUrl = context.sandbox.browser.cdpUrl;
          const projectRoot = join(root, 'projects', job.id);
          phase = '恢复项目';
          const savedSource = job.draftSourceKey ?? job.publication?.sourceKey;
          if (savedSource) await restoreProject(projectRoot, savedSource);
          phase = '生成游戏';
          await generateGame(job, {
            dataDir: root, apiKey: context.env.DASHSCOPE_API_KEY!, baseUrl: context.env.DASHSCOPE_BASE_URL!.replace(/\/+$/u, ''),
            playtest: async (work) => {
              const report = await runWebPlaytest(work, { cdpUrl });
              // Keep actionable host findings in platform logs; never log source,
              // model requests, credentials or the managed browser endpoint.
              const sanitize = (value: string) => value.replace(/(?:https?|wss?):\/\/\S+/gu, '[url]').slice(0, 600);
              console.info('LUDO_PLAYTEST_RESULT', JSON.stringify({
                id: job.id, revision: job.revision ?? 0, score: report.score, verdict: report.verdict,
                checks: report.checks.filter((check) => check.status === 'repair').map(({ label, message }) => ({ label, message: sanitize(message) })),
                observations: report.observations.filter((entry) => entry.status === 'repair').slice(0, 12).map(({ stepId, message }) => ({ stepId, message: sanitize(message) })),
              }));
              return report;
            },
          }, async (stage, message) => { await update('running', stage, message); send({ stage }); });
          phase = '保存成品';
          const publication = await saveProject(projectRoot, job, runId);
          await update('complete', '制作完成', '游戏已准备好，可以试玩和下载。', { publication });
          send({ complete: true });
        } catch (error) {
          const sanitizeError = (value: string) => Object.values(context.env).filter((value): value is string => typeof value === 'string' && value.length > 20)
            .reduce((result, value) => result.replaceAll(value, '[已隐藏]'), value).replace(/(?:https?|wss?):\/\/\S+/gu, '[url]').slice(0, 3000);
          const failure = { phase, message: sanitizeError(error instanceof Error ? error.stack ?? error.message : String(error)) };
          console.error('LUDO_PRODUCTION_FAILURE', JSON.stringify({ id: job.id, revision: job.revision ?? 0, ...failure }));
          // Preserve the actual failed attempt privately. A later revision can
          // reuse its art and source, while the published version stays intact.
          let draftSourceKey = job.draftSourceKey;
          // Acquisition fails before restore. An error-only draft must not
          // replace a previously saved game and its reusable art.
          if (root && phase !== '浏览器准备') {
            try {
              const work = join(root, 'projects', job.id, '.production', 'work');
              await mkdir(work, { recursive: true });
              await writeFile(join(work, 'production-error.json'), JSON.stringify(failure));
              draftSourceKey = await saveDraft(work, job, runId);
            } catch { console.warn('LUDO_DRAFT_SAVE_FAILED', JSON.stringify({ id: job.id, revision: job.revision ?? 0 })); }
          }
          const detail = error instanceof Error ? error.message : '';
          const sandboxQuotaExceeded = phase === '浏览器准备' && /Monthly sandbox GB-s quota exceeded/iu.test(detail);
          const message = sandboxQuotaExceeded ? '云端试玩资源本周期额度不足，项目已保留。额度恢复后可继续修改。'
            : phase === '浏览器准备' ? '云端浏览器初始化失败，项目已保留，请稍后继续修改。' : /千问|图像|图片|游戏代码|语法检查|素材|审查|试玩|修复|规划|托管浏览器/iu.test(detail)
            ? detail.slice(0, 180) : '制作过程中遇到问题，请联系网站管理员并提供项目编号。';
          await update('failed', '制作中断', message, { error: message, ...(draftSourceKey ? { draftSourceKey } : {}) }).catch(() => undefined);
          send({ failed: true });
        } finally {
          clearInterval(heartbeat);
          // The SDK lazily acquires on tool access. Never call kill after a
          // failed acquisition; only release an instance this task initialized.
          if (sandboxInitialized) {
            try { await context.sandbox!.kill(); }
            catch { console.warn('LUDO_SANDBOX_RELEASE_FAILED', JSON.stringify({ id: job.id, revision: job.revision ?? 0 })); }
          }
          if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
          if (connected) { try { controller.close(); } catch { /* Transport already closed. */ } }
        }
      },
      cancel() { connected = false; },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
  } catch (error) { const failure = publicError(error); return Response.json({ error: failure.error }, { status: failure.status }); }
}

async function restoreProject(root: string, sourceKey: string): Promise<void> {
  const blob = getStore('ludoready-projects');
  const source = await blob.get(sourceKey, { type: 'json', consistency: 'strong' }) as { files: SavedFile[] } | null;
  if (!source) throw new Error('现有游戏项目无法读取。');
  for (const file of source.files) {
    if (file.path.startsWith('/') || file.path.includes('\0') || file.path.split('/').includes('..')) throw new Error('游戏项目文件路径无效。');
    const bytes = await blob.get(file.key, { type: 'arrayBuffer', consistency: 'strong' }) as ArrayBuffer | null;
    if (!bytes) throw new Error('现有游戏素材无法读取。');
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(bytes));
  }
}

async function saveDraft(root: string, job: CloudJob, runId: string): Promise<string | undefined> {
  const blob = getStore('ludoready-projects');
  const prefix = `projects/${job.id}/${job.revision ?? 0}/${runId}/draft`;
  const files: SavedFile[] = [];
  async function visit(path: string): Promise<void> {
    let entries;
    try { entries = await readdir(join(root, path), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('制作文件不能包含符号链接。');
      const relative = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) {
        const bytes = await readFile(join(root, relative));
        if (bytes.length > CHUNK_SIZE) throw new Error('制作记录超过存储限制。');
        const key = `${prefix}/files/${relative}`;
        await blob.set(key, Uint8Array.from(bytes).buffer);
        files.push({ path: relative, key, size: bytes.length });
      }
    }
  }
  await visit('');
  if (!files.length) return undefined;
  const key = `${prefix}/source.json`;
  await blob.setJSON(key, { id: job.id, revision: job.revision ?? 0, files });
  return key;
}

async function saveProject(root: string, job: CloudJob, runId: string): Promise<Publication> {
  const blob = getStore('ludoready-projects');
  const prefix = `projects/${job.id}/${job.revision ?? 0}/${runId}`;
  const saved: SavedFile[] = [];
  const publication: Publication = { files: [], archiveKeys: [], sourceKey: `${prefix}/source.json` };
  async function save(path: string): Promise<void> {
    const bytes = await readFile(join(root, path));
    if (bytes.length > CHUNK_SIZE) throw new Error('游戏素材超过当前网页托管的单文件大小限制。');
    const key = `${prefix}/files/${path}`;
    await blob.set(key, Uint8Array.from(bytes).buffer);
    saved.push({ path, key, size: bytes.length });
    if (path.startsWith('public/')) publication.files.push({ path: path.slice(7), key, size: bytes.length, type: fileType(path) });
  }
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('游戏素材不能包含符号链接。');
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && !entry.name.startsWith('.')) await save(path);
    }
  }
  await visit('public');
  for (const path of ['production-source.json', 'production-assets.json', 'production-plan.json', 'production-history.json', 'GAME_DESIGN.md', '.ludoready/playtest.json']) await save(path);
  await visit('artifacts');
  const archive = await projectZip(join(root, 'public'));
  for (let offset = 0; offset < archive.length; offset += CHUNK_SIZE) {
    const bytes = archive.subarray(offset, offset + CHUNK_SIZE);
    const key = `${prefix}/archive/${publication.archiveKeys.length}`;
    await blob.set(key, Uint8Array.from(bytes).buffer);
    publication.archiveKeys.push({ key, size: bytes.length });
  }
  await blob.setJSON(publication.sourceKey, { id: job.id, revision: job.revision ?? 0, files: saved });
  return publication;
}
