import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PUBLICATION_CHUNK_SIZE, restoreProject, saveDraft, saveProject, type ObjectStore } from './publication.js';

it('restores legacy manifests and keeps draft, publication and ZIP keys compatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ludo-publication-'));
  const values = new Map<string, any>();
  const store: ObjectStore = {
    async getBytes(key) { return values.get(key) ?? null; },
    async getJSON<T>(key: string) { return values.get(key) as T ?? null; },
    async setBytes(key, bytes) { values.set(key, Uint8Array.from(bytes)); },
    async setJSON(key, value) { values.set(key, structuredClone(value)); },
  };
  const id = '11111111-1111-4111-8111-111111111111';
  const files: Record<string, Uint8Array> = {
    'public/index.html': Buffer.from('<canvas id="game"></canvas>'),
    'public/assets/scene.png': new Uint8Array(PUBLICATION_CHUNK_SIZE).fill(42),
    'production-source.json': Buffer.from('{"html":"<canvas></canvas>"}'),
    'production-assets.json': Buffer.from('["public/assets/scene.png"]'),
    'production-plan.json': Buffer.from('{"title":"旧游戏"}'),
    'production-history.json': Buffer.from('[{"verdict":"repair"}]'),
    'GAME_DESIGN.md': Buffer.from('方向键移动'),
    '.ludoready/playtest.json': Buffer.from('{}'),
    'artifacts/playtest/latest/report.json': Buffer.from('{"score":100}'),
  };
  values.set('legacy/source', { files: Object.entries(files).map(([path, bytes], index) => {
    const key = `legacy/files/${index}`;
    values.set(key, bytes);
    return { path, key, size: bytes.byteLength };
  }) });
  try {
    await restoreProject(join(root, 'restored'), 'legacy/source', store);
    const fingerprint = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    expect(fingerprint(await readFile(join(root, 'restored/public/assets/scene.png')))).toBe(fingerprint(files['public/assets/scene.png']!));
    const draftKey = await saveDraft(join(root, 'restored'), { id, revision: 1 }, 'retry-run', store);
    expect(draftKey).toBe(`projects/${id}/1/retry-run/draft/source.json`);
    expect(values.get(draftKey!)).toMatchObject({ id, revision: 1 });
    await restoreProject(join(root, 'draft-restored'), draftKey!, store);
    expect(await readFile(join(root, 'draft-restored/production-history.json'), 'utf8')).toBe('[{"verdict":"repair"}]');
    const publication = await saveProject(join(root, 'draft-restored'), { id, revision: 1 }, 'complete-run', store);
    expect(publication.sourceKey).toBe(`projects/${id}/1/complete-run/source.json`);
    expect(publication.files.map((file) => file.path).sort()).toEqual(['assets/scene.png', 'index.html']);
    expect(publication.files.find((file) => file.path === 'index.html')?.type).toBe('text/html; charset=utf-8');
    expect(publication.archiveKeys).toHaveLength(2);
    expect(publication.archiveKeys[0]).toMatchObject({ key: `projects/${id}/1/complete-run/archive/0`, size: PUBLICATION_CHUNK_SIZE });
    const zip = Buffer.concat(publication.archiveKeys.map(({ key }) => Buffer.from(values.get(key))));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(values.has(draftKey!)).toBe(true);
    expect(values.has('legacy/source')).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects unsafe legacy paths before writing outside the project', async () => {
  const store = { getJSON: async () => ({ files: [{ path: '../outside', key: 'legacy/file', size: 1 }] }) } as unknown as ObjectStore;
  await expect(restoreProject('/unused-project', 'legacy/source', store)).rejects.toThrow('路径无效');
});
