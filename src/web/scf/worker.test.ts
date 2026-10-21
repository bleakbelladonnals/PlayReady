import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { CloudJob } from '../edgeone/rpc.js';
import type { ObjectStore } from '../server/publication.js';
import { createGatewayStore, runWorker } from './worker.js';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), playtest: vi.fn(), state: vi.fn(), browser: vi.fn() }));
vi.mock('../server/generator.js', () => ({ generateGame: mocks.generate }));
vi.mock('../server/playtest.js', () => ({ runWebPlaytest: mocks.playtest }));
vi.mock('./browser.js', () => ({ browserConfig: mocks.browser, probeBrowser: vi.fn() }));
vi.mock('../edgeone/rpc.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../edgeone/rpc.js')>(), stateCall: mocks.state }));
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

const env = { DASHSCOPE_API_KEY: 'local-model-key', DASHSCOPE_BASE_URL: 'https://unused.example.com/v1', LUDO_STORAGE_URL: 'https://unused.example.com/api/worker/storage', LUDO_WORKER_SECRET: 'local-worker-secret' };
const id = '11111111-1111-4111-8111-111111111111';
const job = (): CloudJob & { runId: string } => ({ id, runId: 'claimed-run-identifier', prompt: '森林接苹果', status: 'running', stage: '准备制作', error: null, events: [], createdAt: new Date().toISOString(), sessionHash: 'private-session', previewToken: 'private-preview', revision: 1, draftSourceKey: 'legacy/draft', hasPublished: true, publication: { sourceKey: 'published/source', files: [], archiveKeys: [] }, publishedRevision: 0 });
function memoryStore() {
  const values = new Map<string, any>();
  const store: ObjectStore = {
    async getBytes(key) { return values.get(key) ?? null; },
    async getJSON<T>(key: string) { return values.get(key) as T ?? null; },
    async setBytes(key, bytes) { values.set(key, Uint8Array.from(bytes)); },
    async setJSON(key, value) { values.set(key, structuredClone(value)); },
  };
  return { store, values };
}

it('exits an empty queue without browser initialization or generation', async () => {
  mocks.state.mockResolvedValue({ claimed: false });
  expect(await runWorker(env, memoryStore().store)).toEqual({ claimed: false, started: false });
  expect(mocks.state).toHaveBeenCalledExactlyOnceWith(env, 'claim-next', {});
  expect(mocks.browser).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
});

it('retains the previous draft and publication when browser initialization fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const previous = job();
  const { store, values } = memoryStore();
  mocks.state.mockImplementation(async (_env, op) => op === 'claim-next' ? { claimed: true, job: previous } : { ok: true });
  mocks.browser.mockRejectedValue(new Error('Chromium 不可用'));
  expect(await runWorker(env, store)).toMatchObject({ claimed: true, complete: false });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(values.size).toBe(0);
  const failed = mocks.state.mock.calls.find(([, op]) => op === 'update')![2];
  expect(failed).toMatchObject({ id, revision: 1, runId: previous.runId, status: 'failed', draftSourceKey: 'legacy/draft' });
  expect(failed).not.toHaveProperty('publication');
});

it('restores previous art and persists a failed generation privately before cleaning temporary files', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const previous = job();
  const { store, values } = memoryStore();
  const art = Buffer.from([137, 80, 78, 71, 8, 9]);
  values.set('legacy/art', art);
  values.set('legacy/source-file', Buffer.from('{"title":"原游戏"}'));
  values.set('legacy/draft', { files: [{ path: 'public/assets/fox.png', key: 'legacy/art', size: art.length }, { path: 'production-source.json', key: 'legacy/source-file', size: 23 }] });
  mocks.state.mockImplementation(async (_env, op) => op === 'claim-next' ? { claimed: true, job: previous } : { ok: true });
  const launch = { executablePath: '/unused/chromium', args: ['--no-sandbox'], env: {} };
  mocks.browser.mockResolvedValue(launch);
  mocks.playtest.mockResolvedValue({ score: 50, verdict: 'repair' });
  let temporaryRoot = '';
  let restoredArt: Buffer | undefined;
  mocks.generate.mockImplementation(async (_job, config) => {
    temporaryRoot = config.dataDir;
    const project = join(config.dataDir, 'projects', id);
    restoredArt = await readFile(join(project, 'public/assets/fox.png'));
    const work = join(project, '.production', 'work');
    await mkdir(join(work, 'public', 'assets'), { recursive: true });
    await writeFile(join(work, 'public', 'assets', 'fox.png'), restoredArt);
    await writeFile(join(work, 'production-history.json'), '[{"verdict":"repair"}]');
    await config.playtest(work);
    throw new Error('修复后仍未通过试玩');
  });
  expect(await runWorker(env, store)).toMatchObject({ complete: false });
  expect(restoredArt).toEqual(art);
  expect(mocks.playtest).toHaveBeenCalledWith(expect.any(String), { launchOptions: launch });
  const failed = mocks.state.mock.calls.find(([, op, input]) => op === 'update' && input.status === 'failed')![2];
  expect(failed.draftSourceKey).toBe(`projects/${id}/1/${previous.runId}/draft/source.json`);
  expect(failed).not.toHaveProperty('publication');
  const manifest = values.get(failed.draftSourceKey);
  expect(Buffer.from(values.get(manifest.files.find((file: { path: string }) => file.path === 'public/assets/fox.png').key))).toEqual(art);
  expect(values.has('legacy/draft')).toBe(true);
  await expect(access(temporaryRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('uploads 4 MiB as raw bytes with private gateway authorization and treats missing files as null', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(null, { status: 404 }));
  const store = createGatewayStore(env, request);
  const bytes = new Uint8Array(4 * 1024 * 1024).fill(7);
  await store.setBytes(`projects/${id}/1/run/files/art.png`, bytes);
  const [url, options] = request.mock.calls[0]!;
  expect(String(url)).toContain(`key=projects%2F${id}%2F1%2Frun%2Ffiles%2Fart.png`);
  expect(options?.headers).toMatchObject({ Authorization: 'Bearer local-worker-secret', 'X-Ludo-Storage-Type': 'bytes' });
  expect(options?.body).toBeInstanceOf(ArrayBuffer);
  expect((options!.body as ArrayBuffer).byteLength).toBe(bytes.byteLength);
  expect(await store.getBytes('missing')).toBeNull();
  await expect(store.setBytes('oversized', new Uint8Array(bytes.length + 1))).rejects.toThrow('超过存储限制');
  expect(request).toHaveBeenCalledTimes(2);
});
