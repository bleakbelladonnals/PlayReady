import { expect, it, vi } from 'vitest';
import type { CloudFunctionContext } from '@edgeone/types';
import { storageHandler } from './storage.js';

const mock = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), setJSON: vi.fn(), store: vi.fn() }));
vi.mock('@edgeone/pages-blob', () => ({ getStore: mock.store }));
const secret = 'worker-secret-'.repeat(4);
const key = 'projects/11111111-1111-4111-8111-111111111111/0/run/files/public/bear.png';
function context(method: string, body?: unknown, authorization = `Bearer ${secret}`, objectKey = key) {
  return { env: { LUDO_WORKER_SECRET: secret }, request: {
    url: `https://games.example.com/api/worker/storage?key=${encodeURIComponent(objectKey)}`, method,
    headers: new Headers({ authorization, 'x-ludo-storage-type': 'bytes' }), body,
  } } as unknown as CloudFunctionContext;
}
it('requires worker authorization before accessing private game objects', async () => {
  mock.store.mockReturnValue(mock);
  await expect(storageHandler(context('GET', undefined, 'Bearer invalid'))).rejects.toMatchObject({ status: 403 });
  await expect(storageHandler(context('GET', undefined, `Bearer ${secret}`, `${key}/../secret`))).rejects.toMatchObject({ status: 400 });
  expect(mock.get).not.toHaveBeenCalled();
});
it('preserves binary image bytes and rejects an oversized callback', async () => {
  mock.store.mockReturnValue(mock);
  const bytes = new Uint8Array([0, 255, 128, 10, 13, 200]);
  mock.get.mockResolvedValue(bytes.buffer);
  expect((await storageHandler(context('PUT', bytes.buffer))).status).toBe(200);
  expect(mock.set).toHaveBeenCalledWith(key, bytes.buffer);
  expect(new Uint8Array(await (await storageHandler(context('GET'))).arrayBuffer())).toEqual(bytes);
  await expect(storageHandler(context('PUT', new Uint8Array(4 * 1024 * 1024 + 1)))).rejects.toMatchObject({ status: 413 });
});
