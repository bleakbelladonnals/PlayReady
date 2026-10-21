'use strict';

const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

const PROJECTS = 'ludoready_projects';
const USAGE = 'ludoready_usage';
const DAILY_LIMIT = 20;
// A 30-minute asynchronous SCF worker gets one minute for final callbacks.
const TASK_TIMEOUT_MS = 31 * 60 * 1000;
const MAX_EVENTS = 60;

class InputError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function response(statusCode, value) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(value) };
}
function failure(status, error) { return response(status, { error }); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function authenticated(event, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const authorization = Object.entries(event?.headers ?? {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const provided = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function prompt(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 1000) throw new InputError(400, `请填写 1–1000 字的${label}。`);
  return text;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value)) throw new InputError(400, '项目编号无效。');
  return value;
}
function runIdentifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(value)) throw new InputError(400, '制作任务标识无效。');
  return value;
}
function revision(value) {
  if (!Number.isInteger(value) || value < 0) throw new InputError(400, '项目版本无效。');
  return value;
}
function owns(job, session) { return job && typeof session === 'string' && hash(session) === job.sessionHash; }
function chinaDay(now) { return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }

// @cloudbase/node-sdk 3.18.3 uses @cloudbase/database 1.4.3:
// transaction.doc.get().data is ONE document or null; doc.set takes raw fields.
// SDK errors may be returned with code, so throw them to preserve transaction retry/rollback.
async function read(ref) {
  const result = await ref.get();
  if (result.code) throw result;
  if (result.data === null) return null;
  const { _id, ...value } = result.data;
  return value;
}
async function write(ref, value) {
  const result = await ref.set(value);
  if (result.code) throw result;
}
function eventFor(job, stage, message, now) {
  job.events.push({ time: now.toISOString(), stage, message, revision: job.revision ?? 0 });
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
}
function setStatus(job, status, stage, message, error, now) {
  job.status = status;
  job.stage = stage;
  job.error = error;
  const change = job.revisions?.find((item) => item.revision === job.revision);
  if (change) change.status = status;
  eventFor(job, stage, message, now);
}

async function loadJob(transaction, id, now) {
  const ref = transaction.collection(PROJECTS).doc(id);
  const job = await read(ref);
  if (!job) return null;
  job.revision ??= 0;
  job.revisions ??= [];
  job.changePrompt ??= null;
  job.hasPublished ??= job.status === 'complete';
  job.publishedRevision ??= job.hasPublished ? 0 : null;
  job.publication ??= null;
  if (job.status === 'running'
      && now.getTime() - Date.parse(job.runStartedAt ?? job.attemptStartedAt ?? job.createdAt) > TASK_TIMEOUT_MS) {
    const error = '本次制作等待时间过长，已停止。项目已保留，请补充要求继续修改。';
    setStatus(job, 'failed', '制作中断', error, error, now);
    job.runId = null;
    job.runStartedAt = null;
    await write(ref, job);
  }
  return job;
}

async function takeBudget(transaction, now) {
  const day = chinaDay(now);
  const ref = transaction.collection(USAGE).doc(day);
  const usage = await read(ref);
  const count = usage?.count ?? 0;
  if (count >= DAILY_LIMIT) return false;
  await write(ref, { day, count: count + 1 });
  return true;
}

function makeJob(text, now) {
  const session = randomBytes(32).toString('base64url');
  const time = now.toISOString();
  const job = {
    id: randomUUID(), prompt: text, status: 'queued', stage: '准备制作', error: null,
    events: [{ time, stage: '准备制作', message: '项目已创建，正在等待制作。', revision: 0 }],
    createdAt: time, sessionHash: hash(session), previewToken: randomBytes(32).toString('base64url'),
    revision: 0, changePrompt: null, revisions: [], hasPublished: false, publishedRevision: null,
    publication: null, runId: null, runStartedAt: null, attemptStartedAt: time,
  };
  return { job, session };
}

function validatePublication(value) {
  const isKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= 1000;
  const isSize = (size) => Number.isSafeInteger(size) && size >= 0;
  if (!value || !Array.isArray(value.files) || !value.files.length || value.files.length > 80
      || !Array.isArray(value.archiveKeys) || !value.archiveKeys.length || !isKey(value.sourceKey)
      || value.files.some((file) => !isKey(file.path) || file.path.startsWith('/') || file.path.split('/').some((part) => part === '.' || part === '..') || !isKey(file.key) || !isSize(file.size) || !isKey(file.type))
      || value.archiveKeys.some((part) => !isKey(part.key) || !isSize(part.size))) {
    throw new InputError(400, '已发布游戏的文件清单无效。');
  }
  return {
    files: value.files.map(({ path, key, size, type }) => ({ path, key, size, type })),
    archiveKeys: value.archiveKeys.map(({ key, size }) => ({ key, size })), sourceKey: value.sourceKey,
  };
}

function parse(event) {
  if (event.httpMethod !== 'POST') throw new InputError(405, '请使用 POST 请求。');
  if (typeof event.body !== 'string') throw new InputError(400, '请求体必须为 JSON。');
  let input;
  try { input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body); }
  catch { throw new InputError(400, '请求体必须为有效 JSON。'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError(400, '请求格式无效。');
  if (['desktop-submit', 'desktop-result', 'desktop-poll', 'desktop-heartbeat', 'desktop-complete', 'desktop-events', 'desktop-read-events'].includes(input.op)) {
    if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024) throw new InputError(400, '工作台传输内容过大。');
    if (['desktop-submit', 'desktop-result', 'desktop-complete'].includes(input.op)) identifier(input.id);
    if (['desktop-poll', 'desktop-heartbeat', 'desktop-complete', 'desktop-events'].includes(input.op)) identifier(input.workerId);
    return input;
  }
  if (!['create', 'get', 'authorized', 'preview', 'revise', 'claim', 'claim-next', 'update'].includes(input.op)) throw new InputError(400, '请求操作无效。');
  if (input.op === 'create') input.prompt = prompt(input.prompt, '游戏想法');
  else if (input.op !== 'claim-next') identifier(input.id);
  if (input.op === 'revise') input.prompt = prompt(input.prompt, '修改要求');
  if (input.op === 'claim' || input.op === 'update') {
    revision(input.revision);
    runIdentifier(input.runId);
  }
  if (input.op === 'update') {
    if (!['running', 'complete', 'failed'].includes(input.status) || typeof input.stage !== 'string' || !input.stage || input.stage.length > 80
        || typeof input.message !== 'string' || input.message.length > 4000 || input.error != null && typeof input.error !== 'string') throw new InputError(400, '制作进度格式无效。');
    if (input.status === 'complete') input.publication = validatePublication(input.publication);
    if (input.draftSourceKey !== undefined && (typeof input.draftSourceKey !== 'string' || !input.draftSourceKey || input.draftSourceKey.length > 1000)) {
      throw new InputError(400, '制作草稿标识无效。');
    }
  }
  return input;
}

function createStateBridge(db, secret) {
  return async function handle(event) {
    if (!authenticated(event, secret)) return failure(403, '状态服务请求未获授权。');
    try {
      const input = parse(event);
      // Production queues use the PostgreSQL transaction below, never this
      // historical NoSQL adapter's per-document transaction.
      if (input.op === 'claim-next') throw new InputError(400, '请求操作无效。');
      const now = new Date();
      // Generate identities outside the retryable callback. No external APIs run in a transaction.
      const created = input.op === 'create' ? makeJob(input.prompt, now) : null;
      return await db.runTransaction(async (transaction) => {
        if (created) {
          if (!await takeBudget(transaction, now)) return failure(429, '今天的制作名额已满，请明天再试。每次修改也会使用一个制作名额。');
          await write(transaction.collection(PROJECTS).doc(created.job.id), created.job);
          return response(200, created);
        }
        const job = await loadJob(transaction, input.id, now);
        if (input.op === 'get') return response(200, { job });
        if (input.op === 'authorized') return response(200, { job: owns(job, input.session) ? job : null });
        if (input.op === 'preview') return response(200, { job: job?.hasPublished && typeof input.token === 'string' && input.token === job.previewToken ? job : null });
        if (!job || (input.op === 'revise' || input.op === 'claim') && !owns(job, input.session)) return failure(404, '找不到这个项目，请在原浏览器中打开。');
        const ref = transaction.collection(PROJECTS).doc(job.id);
        if (input.op === 'revise') {
          if (['queued', 'running'].includes(job.status)) return failure(409, '这个项目正在制作，请等待当前制作结束。');
          if (!await takeBudget(transaction, now)) return failure(429, '今天的制作名额已满，请明天再试。每次修改也会使用一个制作名额。');
          job.revision += 1;
          job.changePrompt = input.prompt;
          job.revisions.push({ revision: job.revision, prompt: input.prompt, time: now.toISOString(), status: 'queued' });
          job.runId = null;
          job.runStartedAt = null;
          job.attemptStartedAt = now.toISOString();
          setStatus(job, 'queued', '准备制作', `已收到第 ${job.revision} 次修改：${input.prompt}`, null, now);
          await write(ref, job);
          return response(200, { job });
        }
        if (input.op === 'claim') {
          if (job.status !== 'queued' || job.revision !== input.revision) return response(200, { claimed: false });
          job.runId = input.runId;
          job.runStartedAt = now.toISOString();
          setStatus(job, 'running', '准备制作', job.revision ? '已开始根据修改要求继续制作。' : '已开始制作你的 2D 网页游戏。', null, now);
          await write(ref, job);
          return response(200, { claimed: true, job });
        }
        if (job.status !== 'running' || job.revision !== input.revision || job.runId !== input.runId) return failure(409, '制作任务已经结束或被新的修改替代。');
        setStatus(job, input.status, input.stage, input.message, input.error ?? null, now);
        if (input.draftSourceKey !== undefined) job.draftSourceKey = input.draftSourceKey;
        if (input.status === 'complete') {
          job.hasPublished = true;
          job.publishedRevision = job.revision;
          job.publication = input.publication;
          delete job.draftSourceKey;
        }
        if (input.status !== 'running') {
          job.runId = null;
          job.runStartedAt = null;
        }
        await write(ref, job);
        return response(200, { ok: true, job });
      });
    } catch (error) {
      if (error instanceof InputError) return failure(error.status, error.message);
      return failure(500, '项目状态服务暂时不可用，请稍后重试。');
    }
  };
}

exports.createStateBridge = createStateBridge;

/** PG's SQL function owns all transactions. node-sdk 3.18.3 has rdb().from(),
 * but no rdb().rpc(); use a server-only service_role API Key with the official REST RPC.
 * Injectable dependencies verify the HTTP contract, not database atomicity. */
function createPostgresBridge({ envId, secret, tokenProvider, fetch: request = globalThis.fetch }) {
  return async function handle(event) {
    if (!authenticated(event, secret)) return failure(403, '状态服务请求未获授权。');
    let phase = 'LUDO_STATE_PG_REQUEST_FAILED';
    try {
      const parsed = parse(event);
      const { op, session, ...input } = parsed;
      // Only an authenticated backend can dispatch queued work. Ownership is
      // assigned here, not from a browser-supplied run ID or session cookie.
      if (op === 'claim-next') input.runId = randomUUID();
      if (op === 'create') {
        const generated = makeJob(input.prompt, new Date());
        input.generated = {
          id: generated.job.id, session: generated.session,
          sessionHash: generated.job.sessionHash, previewToken: generated.job.previewToken,
        };
      }
      if (['authorized', 'revise', 'claim'].includes(op)) input.sessionHash = typeof session === 'string' ? hash(session) : null;
      phase = 'LUDO_STATE_PG_TOKEN_FAILED';
      const token = await tokenProvider();
      if (typeof token !== 'string' || !token) throw new Error('Invalid runtime credential.');
      let credentialRole = 'opaque';
      try {
        const role = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).role;
        if (typeof role === 'string' && /^[a-z_]{1,40}$/iu.test(role)) credentialRole = role;
      } catch { /* Only inspect a role, never emit credential content. */ }
      phase = 'LUDO_STATE_PG_RPC_FAILED';
      const rpc = op.startsWith('desktop-') ? 'ludoready_desktop_state' : 'ludoready_state';
      const upstream = await request(`https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/${rpc}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json',
          'Accept-Profile': 'public', 'Content-Profile': 'public', 'X-Db-Instance': 'default',
        },
        body: JSON.stringify({ op, input }),
      });
      if (!upstream.ok) {
        const detail = await upstream.json().catch(() => ({}));
        const code = typeof detail.code === 'string' && /^[a-z0-9_.:-]{1,80}$/iu.test(detail.code) ? detail.code : 'UNKNOWN';
        const permission = typeof detail.message === 'string' ? detail.message.match(/permission denied for [a-z_ ]{1,80}/iu)?.[0] : undefined;
        console.error('LUDO_STATE_PG_RPC_HTTP', upstream.status, code, credentialRole, permission || '');
        throw new Error('RPC request failed.');
      }
      const result = await upstream.json();
      if (!result || ![200, 400, 403, 404, 409, 429].includes(result.status)
          || !result.body || typeof result.body !== 'object' || Array.isArray(result.body)) {
        console.error('LUDO_STATE_PG_RPC_RESULT_INVALID');
        throw new Error('Invalid RPC result.');
      }
      return response(result.status, result.body);
    } catch (error) {
      if (error instanceof InputError) return failure(error.status, error.message);
      // Tokens, headers, request data and upstream error details never enter logs.
      console.error(phase);
      return failure(500, '项目状态服务暂时不可用，请稍后重试。');
    }
  };
}
exports.createPostgresBridge = createPostgresBridge;

let bridge;
exports.main = async function main(event) {
  const secret = process.env.LUDO_STATE_SECRET;
  if (!authenticated(event, secret)) return failure(403, '状态服务请求未获授权。');
  try {
    if (!bridge) {
      const cloudbase = require('@cloudbase/node-sdk');
      const context = cloudbase.getCloudbaseContext();
      const envId = context.TCB_ENV || context.SCF_NAMESPACE;
      if (!envId) throw new Error('Event environment is unavailable.');
      bridge = createPostgresBridge({
        envId, secret,
        tokenProvider: async () => process.env.LUDO_PG_API_KEY,
      });
    }
    return await bridge(event);
  } catch {
    console.error('LUDO_STATE_PG_INIT_FAILED');
    return failure(500, '项目状态服务暂时不可用，请稍后重试。');
  }
};
