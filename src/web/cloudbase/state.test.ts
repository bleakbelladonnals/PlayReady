import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createStateBridge, createPostgresBridge } = require('./state.cjs');
const secret = 'local-test-secret-32-characters-long';
const id = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const session = 'local-project-session';
const event = (input: unknown) => ({ httpMethod: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify(input) });
const body = (value: { body: string }) => JSON.parse(value.body);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function job() {
  return {
    _id: id, id, prompt: '企鹅跑酷', status: 'running', stage: '制作玩法', error: null,
    sessionHash: createHash('sha256').update(session).digest('hex'), previewToken: 'preview-token',
    createdAt: new Date().toISOString(), events: [], revision: 1, changePrompt: '增加生命',
    revisions: [{ revision: 1, prompt: '增加生命', time: new Date().toISOString(), status: 'running' }],
    hasPublished: true, publishedRevision: 0, publication: { sourceKey: 'old/source.json' },
    runId, runStartedAt: new Date().toISOString(), attemptStartedAt: new Date().toISOString(),
  };
}

// This fixture checks the SDK's one-document data shape and state guards only.
// It does not simulate transactions or claim evidence about distributed atomicity.
function documentFixture(value: ReturnType<typeof job>) {
  const set = vi.fn(async (_value: unknown) => ({ updated: 1 }));
  const get = vi.fn(async () => ({ data: structuredClone(value) }));
  const doc = vi.fn((requestedId: string) => {
    expect(requestedId).toBe(id);
    return { get, set };
  });
  const collection = vi.fn((name: string) => {
    expect(name).toBe('ludoready_projects');
    return { doc };
  });
  const db = { runTransaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({ collection })) };
  return { db, get, set };
}

describe('CloudBase state HTTP bridge', () => {
  it('rejects missing authorization before any database call and returns the standard HTTP shape', async () => {
    const db = { runTransaction: vi.fn() };
    const handle = createStateBridge(db, secret);
    const denied = await handle({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ op: 'create', prompt: '游戏' }) });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(typeof denied.body).toBe('string');
    expect(denied.body).not.toContain(secret);
    expect(db.runTransaction).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON before a transaction and hides storage error details', async () => {
    const db = { runTransaction: vi.fn().mockRejectedValue({ code: 'DATABASE_TRANSACTION_CONFLICT', message: 'sensitive internal location' }) };
    const handle = createStateBridge(db, secret);
    const malformed = await handle({ ...event({}), body: '{' });
    expect(malformed.statusCode).toBe(400);
    expect(db.runTransaction).not.toHaveBeenCalled();
    const failed = await handle(event({ op: 'get', id }));
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('sensitive internal location');
  });

  it('reads the documented single-object data shape, strips _id, and refuses a duplicate running claim', async () => {
    const fixture = documentFixture(job());
    const handle = createStateBridge(fixture.db, secret);
    const get = await handle(event({ op: 'authorized', id, session }));
    expect(body(get).job).toMatchObject({ id, revision: 1, hasPublished: true });
    expect(body(get).job).not.toHaveProperty('_id');
    const claim = await handle(event({ op: 'claim', id, session, revision: 1, runId }));
    expect(body(claim)).toEqual({ claimed: false });
    expect(fixture.set).not.toHaveBeenCalled();
  });

  it('blocks stale worker callbacks without writing over the current revision', async () => {
    const fixture = documentFixture(job());
    const handle = createStateBridge(fixture.db, secret);
    const stale = await handle(event({ op: 'update', id, revision: 0, runId, status: 'failed', stage: '制作中断', message: '旧回调', draftSourceKey: 'stale/draft.json' }));
    expect(stale.statusCode).toBe(409);
    const wrongRun = await handle(event({ op: 'update', id, revision: 1, runId: '33333333-3333-4333-8333-333333333333', status: 'running', stage: '制作玩法', message: '重复任务' }));
    expect(wrongRun.statusCode).toBe(409);
    expect(fixture.set).not.toHaveBeenCalled();
  });

  it('commits timeout failure before rejecting an expired callback and retains the published game', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
    const previous = job();
    vi.setSystemTime(new Date('2026-09-27T01:06:00Z'));
    const fixture = documentFixture(previous);
    const result = await createStateBridge(fixture.db, secret)(event({ op: 'update', id, revision: 1, runId, status: 'running', stage: '制作玩法', message: '迟到的回调' }));
    expect(result.statusCode).toBe(409);
    expect(fixture.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'failed', runId: null, hasPublished: true, publishedRevision: 0, publication: previous.publication }));
  });

  it('keeps an unstarted queued project available after a long wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
    const queued = { ...job(), status: 'queued' };
    vi.setSystemTime(new Date('2026-09-27T01:06:00Z'));
    const fixture = documentFixture(queued);
    const result = await createStateBridge(fixture.db, secret)(event({ op: 'get', id }));
    expect(body(result).job.status).toBe('queued');
    expect(fixture.set).not.toHaveBeenCalled();
  });

  it('publishes metadata only on a matching successful task and writes raw document fields', async () => {
    const fixture = documentFixture({ ...job(), draftSourceKey: 'failed/draft.json' } as ReturnType<typeof job>);
    const publication = {
      files: [{ path: 'index.html', key: `${id}/1/index.html`, size: 1024, type: 'text/html' }],
      archiveKeys: [{ key: `${id}/1/game.zip`, size: 4096 }], sourceKey: `${id}/1/source.json`,
    };
    const result = await createStateBridge(fixture.db, secret)(event({ op: 'update', id, revision: 1, runId, status: 'complete', stage: '制作完成', message: '已完成', publication }));
    expect(result.statusCode).toBe(200);
    expect(body(result).job).toMatchObject({ status: 'complete', hasPublished: true, publishedRevision: 1, publication, runId: null });
    const written = fixture.set.mock.calls[0]?.[0];
    expect(written).not.toHaveProperty('_id');
    expect(written).not.toHaveProperty('data');
    expect(written).not.toHaveProperty('draftSourceKey');
  });

  it('retains the last published files when the current revision reports failure', async () => {
    const previous = job();
    const fixture = documentFixture(previous);
    const result = await createStateBridge(fixture.db, secret)(event({ op: 'update', id, revision: 1, runId, status: 'failed', stage: '制作中断', message: '试玩未通过', error: '试玩未通过', draftSourceKey: 'current/draft.json' }));
    expect(result.statusCode).toBe(200);
    expect(body(result).job).toMatchObject({ status: 'failed', hasPublished: true, publishedRevision: 0, publication: previous.publication, runId: null, revisions: [{ revision: 1, status: 'failed' }] });
    expect(body(result).job.draftSourceKey).toBe('current/draft.json');
  });
});

describe('CloudBase PostgreSQL HTTP bridge', () => {
  it('rejects unauthenticated or malformed input before requesting a runtime credential', async () => {
    const tokenProvider = vi.fn();
    const request = vi.fn();
    const handle = createPostgresBridge({ envId: 'local-env', secret, tokenProvider, fetch: request });
    expect((await handle({ ...event({ op: 'create', prompt: '游戏' }), headers: {} })).statusCode).toBe(403);
    expect((await handle({ ...event({ op: 'claim-next' }), headers: {} })).statusCode).toBe(403);
    expect((await handle({ ...event({}), body: '{' })).statusCode).toBe(400);
    expect((await handle(event({ op: 'update', id, revision: 1, runId, status: 'failed', stage: '制作中断', message: '失败', draftSourceKey: '' }))).statusCode).toBe(400);
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('sends the official RPC HTTP shape, generated identities and session hashes, then unwraps SQL business results', async () => {
    // Exercise actual local HTTP transport. This endpoint checks the wire contract
    // only; PostgreSQL transaction correctness needs the deployed SQL function.
    const received: Array<{ input: Record<string, any>; op: string }> = [];
    const headers: Array<import('node:http').IncomingHttpHeaders> = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      const value = JSON.parse(raw);
      received.push(value);
      headers.push(req.headers);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value.op === 'claim-next'
        ? { status: 200, body: { claimed: true, job: { id, revision: 1, runId: value.input.runId, prompt: '企鹅跑酷' } } }
        : value.op === 'create'
        ? { status: 200, body: { job: { id: value.input.generated.id }, session: value.input.generated.session } }
        : { status: 409, body: { error: '这个项目正在制作。' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local HTTP endpoint unavailable');
    const tokenProvider = vi.fn(async () => 'local-runtime-token');
    const handle = createPostgresBridge({
      envId: 'local-env', secret, tokenProvider,
      fetch: async (url: string, init: RequestInit) => {
        expect(url).toBe('https://local-env.api.tcloudbasegateway.com/v1/rdb/rest/rpc/ludoready_state');
        return fetch(`http://127.0.0.1:${address.port}/rpc/ludoready_state`, init);
      },
    });
    try {
      const created = await handle(event({ op: 'create', prompt: '企鹅跑酷', generated: { id: 'untrusted-id' } }));
      expect(created.statusCode).toBe(200);
      const generated = received[0]!.input.generated;
      expect(generated.id).toMatch(/^[a-f0-9-]{36}$/u);
      expect(generated.session).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(generated.previewToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(generated.sessionHash).toBe(createHash('sha256').update(generated.session).digest('hex'));
      expect(body(created).session).toBe(generated.session);
      const conflict = await handle(event({ op: 'claim', id, session, revision: 1, runId, sessionHash: 'untrusted-hash' }));
      expect(conflict.statusCode).toBe(409);
      expect(body(conflict)).toEqual({ error: '这个项目正在制作。' });
      expect(received[1]!.input).toMatchObject({ id, revision: 1, runId, sessionHash: createHash('sha256').update(session).digest('hex') });
      expect(received[1]!.input).not.toHaveProperty('session');
      expect(headers[0]).toMatchObject({ authorization: 'Bearer local-runtime-token', 'accept-profile': 'public', 'content-profile': 'public', 'x-db-instance': 'default' });
      const queued = await handle(event({ op: 'claim-next', runId: 'untrusted-worker-id', session: 'untrusted-session' }));
      expect(queued.statusCode).toBe(200);
      expect(body(queued)).toMatchObject({ claimed: true, job: { id, revision: 1, prompt: '企鹅跑酷', runId: received[2]!.input.runId } });
      expect(received[2]).toEqual({ op: 'claim-next', input: { runId: expect.stringMatching(/^[a-f0-9-]{36}$/u) } });
      expect(tokenProvider).toHaveBeenCalledTimes(3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not expose credential or upstream error details in the response or logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = createPostgresBridge({
      envId: 'local-env', secret,
      tokenProvider: async () => { throw new Error('private-token-or-header'); },
      fetch: vi.fn(),
    });
    const result = await handle(event({ op: 'get', id }));
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('private-token-or-header');
    expect(log).toHaveBeenCalledExactlyOnceWith('LUDO_STATE_PG_TOKEN_FAILED');
  });
});

// Supply a local PGlite module path to execute the SQL on a real PostgreSQL engine.
// No credentials or cloud endpoints are used. One local connection cannot prove
// distributed contention; these checks cover SQL persistence and worker guards.
describe.skipIf(!process.env.LUDO_TEST_PGLITE_MODULE)('PostgreSQL failed-project continuation', () => {
  it('persists private drafts, protects worker ownership, preserves published versions and charges retries', async () => {
    const { PGlite } = require(process.env.LUDO_TEST_PGLITE_MODULE!);
    const db = new PGlite();
    const call = async (op: string, input: Record<string, unknown>) => (await db.query(
      'SELECT public.ludoready_state($1,$2::jsonb) AS value', [op, JSON.stringify(input)],
    )).rows[0].value;
    try {
      await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
      await db.exec(await readFile(new URL('./state.sql', import.meta.url), 'utf8'));
      await db.exec('SET ROLE service_role;');
      await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: 'service_role' })]);
      const localSession = randomBytes(32).toString('base64url');
      const identity = { id: randomUUID(), session: localSession, sessionHash: createHash('sha256').update(localSession).digest('hex'), previewToken: randomBytes(32).toString('base64url') };
      const created = await call('create', { prompt: '小狐狸接苹果', generated: identity });
      expect(created.status).toBe(200);
      const owner = { id: identity.id, sessionHash: identity.sessionHash };
      const update = { id: identity.id, revision: 0, runId, status: 'failed', stage: '制作中断', message: '未通过真实试玩' };
      expect((await call('claim', { ...owner, revision: 0, runId })).body.claimed).toBe(true);
      expect((await call('update', { ...update, runId: 'wrong-worker-identifier', draftSourceKey: 'wrong/draft.json' })).status).toBe(409);
      expect((await call('update', { ...update, draftSourceKey: null })).status).toBe(400);
      expect((await call('update', { ...update, draftSourceKey: 'projects/current/draft.json' })).status).toBe(200);
      const refreshed = (await call('authorized', owner)).body.job;
      expect(refreshed).toMatchObject({ status: 'failed', prompt: '小狐狸接苹果', hasPublished: false, publication: null, draftSourceKey: 'projects/current/draft.json' });
      expect((await call('preview', { id: identity.id, token: identity.previewToken })).body.job).toBeNull();
      expect((await call('revise', { ...owner, sessionHash: 'wrong', prompt: '修改' })).status).toBe(404);
      const attempts = await Promise.all([
        call('revise', { ...owner, prompt: '保留素材，修复开始按钮' }),
        call('revise', { ...owner, prompt: '重复提交' }),
      ]);
      expect(attempts.map((result) => result.status).sort()).toEqual([200, 409]);
      expect((await call('authorized', owner)).body.job).toMatchObject({ revision: 1, status: 'queued', prompt: '小狐狸接苹果', draftSourceKey: 'projects/current/draft.json' });
      expect((await db.query('SELECT count FROM public.ludoready_usage')).rows[0].count).toBe(2);
      const nextRun = 'next-worker-identifier';
      expect((await call('claim', { ...owner, revision: 1, runId: nextRun })).body.claimed).toBe(true);
      expect((await call('update', { ...update, draftSourceKey: 'stale/draft.json' })).status).toBe(409);
      const publication = { files: [{ path: 'index.html', key: 'published/index.html', size: 100, type: 'text/html' }], archiveKeys: [{ key: 'published/game.zip', size: 200 }], sourceKey: 'published/source.json' };
      const completed = await call('update', { ...update, revision: 1, runId: nextRun, status: 'complete', stage: '制作完成', publication });
      expect(completed.body.job).toMatchObject({ hasPublished: true, publishedRevision: 1, publication });
      expect(completed.body.job).not.toHaveProperty('draftSourceKey');
      expect((await call('revise', { ...owner, prompt: '增加生命' })).status).toBe(200);
      expect((await call('claim', { ...owner, revision: 2, runId: nextRun })).body.claimed).toBe(true);
      const failed = await call('update', { ...update, revision: 2, runId: nextRun, draftSourceKey: 'projects/2/draft.json' });
      expect(failed.body.job).toMatchObject({ status: 'failed', publication, publishedRevision: 1, draftSourceKey: 'projects/2/draft.json' });
      expect((await call('preview', { id: identity.id, token: identity.previewToken })).body.job.publication).toEqual(publication);
      for (let index = 0; index < 17; index++) expect((await call('create', { prompt: '小型游戏', generated: { ...identity, id: randomUUID() } })).status).toBe(200);
      expect((await call('revise', { ...owner, prompt: '超额修改' })).status).toBe(429);
      expect((await call('get', { id: identity.id })).body.job).toMatchObject({ revision: 2, draftSourceKey: 'projects/2/draft.json' });
      expect((await db.query('SELECT count FROM public.ludoready_usage')).rows[0].count).toBe(20);
      await db.exec('RESET ROLE; SET ROLE anon;');
      await expect(db.query('SELECT public.ludoready_state($1,$2::jsonb)', ['get', JSON.stringify({ id: identity.id })])).rejects.toThrow('permission denied');
    } finally { await db.close(); }
  }, 30_000);

  it('claims one queued project globally, reclaims expired workers and keeps owner authorization and revision guards', async () => {
    const { PGlite } = require(process.env.LUDO_TEST_PGLITE_MODULE!);
    const db = new PGlite();
    const call = async (op: string, input: Record<string, unknown> = {}) => (await db.query(
      'SELECT public.ludoready_state($1,$2::jsonb) AS value', [op, JSON.stringify(input)],
    )).rows[0].value;
    try {
      await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
      await db.exec(await readFile(new URL('./state.sql', import.meta.url), 'utf8'));
      await db.exec('SET ROLE service_role;');
      await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: 'service_role' })]);
      const identity = () => {
        const session = randomBytes(32).toString('base64url');
        return { id: randomUUID(), session, sessionHash: createHash('sha256').update(session).digest('hex'), previewToken: randomBytes(32).toString('base64url') };
      };
      const first = identity(); const second = identity();
      expect((await call('create', { prompt: '第一个项目', generated: first })).status).toBe(200);
      expect((await call('create', { prompt: '第二个项目', generated: second })).status).toBe(200);
      const oldPublication = { files: [{ path: 'index.html', key: 'old/index.html', size: 10, type: 'text/html' }], archiveKeys: [{ key: 'old/game.zip', size: 20 }], sourceKey: 'old/source.json' };
      await db.query(`UPDATE public.ludoready_projects SET job = job || $2::jsonb WHERE id = $1`, [first.id, JSON.stringify({
        revision: 1, revisions: [{ revision: 1, prompt: '修改游戏', status: 'queued' }],
        hasPublished: true, publishedRevision: 0, publication: oldPublication, draftSourceKey: 'old/draft/source.json',
        attemptStartedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      })]);
      expect((await call('get', { id: first.id })).body.job.status).toBe('queued');
      expect((await call('claim-next')).status).toBe(400); // RPC requires the bridge-generated run ID.
      const contenders = await Promise.all([
        call('claim-next', { runId: randomUUID() }), call('claim-next', { runId: randomUUID() }),
      ]);
      expect(contenders.map((result) => result.body.claimed).sort()).toEqual([false, true]);
      const acquired = contenders.find((result) => result.body.claimed).body.job;
      expect(acquired).toMatchObject({ id: first.id, revision: 1, status: 'running', publication: oldPublication, draftSourceKey: 'old/draft/source.json' });
      expect(acquired.runId).toMatch(/^[a-f0-9-]{36}$/u);
      expect((await db.query("SELECT count(*)::integer AS count FROM public.ludoready_projects WHERE job ->> 'status'='running'")).rows[0].count).toBe(1);
      expect((await call('claim', { id: second.id, revision: 0, runId: randomUUID(), sessionHash: 'wrong-owner' })).status).toBe(404);
      expect((await call('claim', { id: second.id, revision: 0, runId: randomUUID(), sessionHash: second.sessionHash })).body.claimed).toBe(false);
      const callback = { id: first.id, revision: 1, runId: acquired.runId, status: 'failed', stage: '制作中断', message: '运行已结束' };
      expect((await call('update', { ...callback, revision: 0 })).status).toBe(409);
      expect((await call('update', { ...callback, runId: randomUUID() })).status).toBe(409);
      await db.query(`UPDATE public.ludoready_projects SET job = jsonb_set(job,'{runStartedAt}',$2::jsonb) WHERE id=$1`, [first.id, JSON.stringify(new Date(Date.now() - 32 * 60 * 1000).toISOString())]);
      const next = await call('claim-next', { runId: randomUUID() });
      expect(next.body.job).toMatchObject({ id: second.id, revision: 0, status: 'running' });
      const expired = (await call('get', { id: first.id })).body.job;
      expect(expired).toMatchObject({ status: 'failed', runId: null, runStartedAt: null, publication: oldPublication, publishedRevision: 0, draftSourceKey: 'old/draft/source.json', revisions: [{ revision: 1, status: 'failed' }] });
      expect((await call('update', callback)).status).toBe(409);
      expect((await call('update', { ...callback, id: second.id, revision: 0, runId: next.body.job.runId })).status).toBe(200);
      expect((await call('claim-next', { runId: randomUUID() })).body).toEqual({ claimed: false });
      expect((await db.query('SELECT count FROM public.ludoready_usage')).rows[0].count).toBe(2);
      await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: 'anon' })]);
      expect((await call('claim-next', { runId: randomUUID() })).status).toBe(403);
    } finally { await db.close(); }
  }, 30_000);
});
