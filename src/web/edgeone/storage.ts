import { timingSafeEqual } from 'node:crypto';
import { getStore } from '@edgeone/pages-blob';
import type { CloudFunctionContext } from '@edgeone/types';
import { WebInputError } from '../server/state.js';

export async function storageHandler(context: CloudFunctionContext): Promise<Response> {
  const request = context.request!;
  const secret = context.env.LUDO_WORKER_SECRET;
  const authorization = request.headers.get('authorization');
  if (!secret || secret.length < 32 || !authorization?.startsWith('Bearer ')) throw new WebInputError(403, '请求未获授权。');
  const provided = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new WebInputError(403, '请求未获授权。');
  const key = new URL(request.url).searchParams.get('key');
  if (!key || key.length > 1000 || !/^projects\/[a-f0-9-]{36}\//u.test(key)
      || key.includes('\0') || key.split('/').some((part) => part === '.' || part === '..')) throw new WebInputError(400, '文件标识无效。');
  const type = request.headers.get('x-ludo-storage-type');
  if (type !== 'bytes' && type !== 'json') throw new WebInputError(400, '文件格式无效。');
  const blob = getStore('ludoready-projects');
  if (request.method === 'GET') {
    const value = type === 'bytes' ? await blob.get(key, { type: 'arrayBuffer', consistency: 'strong' })
      : await blob.get(key, { type: 'json', consistency: 'strong' });
    if (value === null) throw new WebInputError(404, '文件不存在。');
    return type === 'json' ? Response.json(value, { headers: { 'Cache-Control': 'no-store' } })
      : new Response(value as ArrayBuffer, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'PUT') throw new WebInputError(405, '不支持此请求。');
  if (Number(request.headers.get('content-length')) > 4 * 1024 * 1024) throw new WebInputError(413, '文件过大。');
  const body = await request.body;
  if (type === 'json') {
    const value = typeof body === 'string' ? JSON.parse(body) : body;
    if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) throw new WebInputError(413, '文件过大。');
    await blob.setJSON(key, value);
  } else {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : ArrayBuffer.isView(body)
      ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : undefined;
    if (!bytes) throw new WebInputError(400, '文件内容无效。');
    if (bytes.byteLength > 4 * 1024 * 1024) throw new WebInputError(413, '文件过大。');
    await blob.set(key, Uint8Array.from(bytes).buffer);
  }
  return Response.json({ saved: true }, { headers: { 'Cache-Control': 'no-store' } });
}
