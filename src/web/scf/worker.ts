import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateGame } from '../server/generator.js';
import { runWebPlaytest } from '../server/playtest.js';
import { PUBLICATION_CHUNK_SIZE, restoreProject, saveDraft, saveProject, type ObjectStore } from '../server/publication.js';
import { requireProvider, stateCall, type CloudJob, type RuntimeEnv } from '../edgeone/rpc.js';
import { browserConfig } from './browser.js';
export { probeBrowser } from './browser.js';

export function createGatewayStore(env: RuntimeEnv, request: typeof fetch = fetch): ObjectStore {
  if (!env.LUDO_STORAGE_URL || !env.LUDO_WORKER_SECRET) throw new Error('制作文件存储服务尚未配置。');
  const endpoint = new URL(env.LUDO_STORAGE_URL);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('制作文件存储服务地址无效。');
  async function send(key: string, type: 'bytes' | 'json', body?: string | ArrayBuffer): Promise<Response> {
    const url = new URL(endpoint);
    url.searchParams.set('key', key);
    const result = await request(url, {
      method: body === undefined ? 'GET' : 'PUT', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${env.LUDO_WORKER_SECRET}`, 'X-Ludo-Storage-Type': type, 'Content-Type': type === 'json' ? 'application/json' : 'application/octet-stream' },
      ...(body === undefined ? {} : { body }),
    });
    if (result.status !== 404 && !result.ok || body !== undefined && !result.ok) throw new Error('制作文件存储请求失败。');
    return result;
  }
  return {
    async getBytes(key) { const result = await send(key, 'bytes'); return result.status === 404 ? null : new Uint8Array(await result.arrayBuffer()); },
    async getJSON<T>(key: string) { const result = await send(key, 'json'); return result.status === 404 ? null : await result.json() as T; },
    async setBytes(key, bytes) {
      if (bytes.byteLength > PUBLICATION_CHUNK_SIZE) throw new Error('制作文件超过存储限制。');
      await send(key, 'bytes', Uint8Array.from(bytes).buffer);
    },
    async setJSON(key, value) {
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > PUBLICATION_CHUNK_SIZE) throw new Error('制作记录超过存储限制。');
      await send(key, 'json', text);
    },
  };
}

/** Invoked by the private SCF Event/timer entrypoint. One invocation owns at most
 * one queued revision; state transactions prevent duplicate workers. */
export async function runWorker(env: RuntimeEnv, store: ObjectStore = createGatewayStore(env)): Promise<{ claimed: boolean; started: boolean; id?: string; revision?: number; complete?: boolean }> {
  const deadlineAt = Date.now() + 28 * 60_000;
  requireProvider(env);
  const { claimed, job } = await stateCall<{ claimed: boolean; job?: CloudJob & { runId: string } }>(env, 'claim-next', {});
  if (!claimed || !job) return { claimed: false, started: false };
  const runId = job.runId;
  const identity = { id: job.id, revision: job.revision ?? 0 };
  const update = (status: string, stage: string, message: string, extra: Record<string, unknown> = {}) => stateCall(env, 'update', { ...identity, runId, status, stage, message, ...extra });
  let root: string | undefined;
  let phase = '浏览器准备';
  try {
    const launchOptions = await browserConfig();
    root = await mkdtemp(join(tmpdir(), 'ludoready-scf-'));
    const projectRoot = join(root, 'projects', job.id);
    phase = '恢复项目';
    const savedSource = job.draftSourceKey ?? job.publication?.sourceKey;
    if (savedSource) await restoreProject(projectRoot, savedSource, store);
    phase = '生成游戏';
    await generateGame(job, {
      dataDir: root, deadlineAt, apiKey: env.DASHSCOPE_API_KEY!, baseUrl: env.DASHSCOPE_BASE_URL!.replace(/\/+$/u, ''),
      playtest: (work) => runWebPlaytest(work, { launchOptions }),
    }, (stage, message) => update('running', stage, message).then(() => undefined));
    phase = '保存成品';
    const publication = await saveProject(projectRoot, job, runId, store);
    await update('complete', '制作完成', '游戏已准备好，可以试玩和下载。', { publication });
    return { claimed: true, started: true, ...identity, complete: true };
  } catch (error) {
    const sanitize = (value: string) => Object.values(env).filter((value): value is string => typeof value === 'string' && value.length > 20)
      .reduce((text, secret) => text.replaceAll(secret, '[已隐藏]'), value).replace(/(?:https?|wss?):\/\/\S+/gu, '[url]').slice(0, 3000);
    const detail = sanitize(error instanceof Error ? error.message : String(error));
    const failure = { phase, message: sanitize(error instanceof Error ? error.stack ?? error.message : String(error)) };
    console.error('LUDO_SCF_PRODUCTION_FAILURE', JSON.stringify({ ...identity, ...failure }));
    let draftSourceKey = job.draftSourceKey;
    // Failed initialization/restoration must never replace an existing source
    // and its reusable images with an error-only record.
    if (root && (phase === '生成游戏' || phase === '保存成品')) {
      try {
        const projectRoot = join(root, 'projects', job.id);
        const work = join(projectRoot, '.production', 'work');
        await mkdir(work, { recursive: true });
        // generateGame moves public out of work on successful host acceptance.
        // Keep those bytes if a later storage/publication callback fails.
        if (phase === '保存成品') await cp(join(projectRoot, 'public'), join(work, 'public'), { recursive: true });
        await writeFile(join(work, 'production-error.json'), JSON.stringify(failure));
        draftSourceKey = await saveDraft(work, job, runId, store) ?? draftSourceKey;
      } catch { console.warn('LUDO_SCF_DRAFT_SAVE_FAILED', JSON.stringify(identity)); }
    }
    const message = phase === '浏览器准备' ? '制作浏览器初始化失败，项目已保留，请稍后继续修改。'
      : /千问|图像|图片|游戏代码|语法检查|素材|审查|试玩|修复|规划|项目/iu.test(detail) ? detail.slice(0, 180)
        : '制作过程中遇到问题，请联系网站管理员并提供项目编号。';
    await update('failed', '制作中断', message, { error: message, ...(draftSourceKey ? { draftSourceKey } : {}) });
    return { claimed: true, started: true, ...identity, complete: false };
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
}
