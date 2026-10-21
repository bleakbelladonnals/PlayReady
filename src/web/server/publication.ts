import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { projectZip } from './archive.js';
import type { Job } from './state.js';
import type { Publication } from '../edgeone/rpc.js';

export interface ObjectStore {
  getBytes(key: string): Promise<Uint8Array | null>;
  getJSON<T>(key: string): Promise<T | null>;
  setBytes(key: string, bytes: Uint8Array): Promise<void>;
  setJSON(key: string, value: unknown): Promise<void>;
}
export const PUBLICATION_CHUNK_SIZE = 4 * 1024 * 1024;
type SavedFile = { path: string; key: string; size: number };
type Identity = Pick<Job, 'id' | 'revision'>;
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8' };

export async function restoreProject(root: string, sourceKey: string, store: ObjectStore): Promise<void> {
  const source = await store.getJSON<{ files: SavedFile[] }>(sourceKey);
  if (!source) throw new Error('现有游戏项目无法读取。');
  for (const file of source.files) {
    if (file.path.startsWith('/') || file.path.includes('\0') || file.path.split('/').some((part) => part === '..' || part === '.')) throw new Error('游戏项目文件路径无效。');
    const bytes = await store.getBytes(file.key);
    if (!bytes) throw new Error('现有游戏素材无法读取。');
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

export async function saveDraft(root: string, job: Identity, runId: string, store: ObjectStore): Promise<string | undefined> {
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
        if (bytes.length > PUBLICATION_CHUNK_SIZE) throw new Error('制作记录超过存储限制。');
        const key = `${prefix}/files/${relative}`;
        await store.setBytes(key, bytes);
        files.push({ path: relative, key, size: bytes.length });
      }
    }
  }
  await visit('');
  if (!files.length) return undefined;
  const key = `${prefix}/source.json`;
  await store.setJSON(key, { id: job.id, revision: job.revision ?? 0, files });
  return key;
}

export async function saveProject(root: string, job: Identity, runId: string, store: ObjectStore): Promise<Publication> {
  const prefix = `projects/${job.id}/${job.revision ?? 0}/${runId}`;
  const saved: SavedFile[] = [];
  const publication: Publication = { files: [], archiveKeys: [], sourceKey: `${prefix}/source.json` };
  async function save(path: string): Promise<void> {
    const bytes = await readFile(join(root, path));
    if (bytes.length > PUBLICATION_CHUNK_SIZE) throw new Error('游戏素材超过当前网页托管的单文件大小限制。');
    const key = `${prefix}/files/${path}`;
    await store.setBytes(key, bytes);
    saved.push({ path, key, size: bytes.length });
    if (path.startsWith('public/')) publication.files.push({ path: path.slice(7), key, size: bytes.length, type: types[extname(path)] ?? 'application/octet-stream' });
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
  for (let offset = 0; offset < archive.length; offset += PUBLICATION_CHUNK_SIZE) {
    const bytes = archive.subarray(offset, offset + PUBLICATION_CHUNK_SIZE);
    const key = `${prefix}/archive/${publication.archiveKeys.length}`;
    await store.setBytes(key, bytes);
    publication.archiveKeys.push({ key, size: bytes.length });
  }
  await store.setJSON(publication.sourceKey, { id: job.id, revision: job.revision ?? 0, files: saved });
  return publication;
}
