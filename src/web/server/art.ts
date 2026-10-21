import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { AssetStore } from '../../main/assetStore.js';

export interface VisualSubject {
  id: string;
  role: 'player' | 'pickup' | 'enemy' | 'object' | 'effect';
  description: string;
  frames: number;
}
export interface ProductionAsset {
  subjectId: string;
  role: string;
  paths: string[];
  width: number;
  height: number;
  frameMs: number;
  targetFps?: number;
  sourceAnimationFps?: number;
  durationMs?: number;
  timingMode?: string;
}

/** Split a generated, evenly spaced atlas into addressable transparent frames.
 * Only white pixels connected to a cell's edge are removed, preserving enclosed
 * white details such as eyes. Each subject uses the union of its frame bounds,
 * so cropping transparent margins preserves animation alignment and scale.
 * The original atlas remains registered as evidence. */
export async function splitGameAtlas(root: string, projectId: string, atlasPath: string, subjects: VisualSubject[], columns: number, rows: number): Promise<ProductionAsset[]> {
  const atlas = PNG.sync.read(await readFile(join(root, atlasPath)));
  const directory = join(root, 'public/assets/images');
  await mkdir(directory, { recursive: true });
  const store = new AssetStore();
  const result: ProductionAsset[] = [];
  let cell = 0;
  for (const subject of subjects) {
    const paths: string[] = [];
    const frames: PNG[] = [];
    for (let frame = 0; frame < subject.frames; frame++, cell++) {
      const x = Math.floor((cell % columns) * atlas.width / columns);
      const y = Math.floor(Math.floor(cell / columns) * atlas.height / rows);
      const width = Math.floor(((cell % columns) + 1) * atlas.width / columns) - x;
      const height = Math.floor((Math.floor(cell / columns) + 1) * atlas.height / rows) - y;
      const image = new PNG({ width, height });
      for (let line = 0; line < height; line++) {
        atlas.data.copy(image.data, line * width * 4, ((y + line) * atlas.width + x) * 4, ((y + line) * atlas.width + x + width) * 4);
      }
      clearEdgeWhite(image);
      frames.push(image);
    }
    const cropped = cropSubjectFrames(frames, subject.id);
    const { width, height } = cropped[0];
    for (const [frame, image] of cropped.entries()) {
      const relativePath = `public/assets/images/${subject.id}-${frame}.png`;
      await writeFile(join(root, relativePath), PNG.sync.write(image));
      await store.registerExisting({
        projectId, root, relativePath, name: `${subject.id}-${frame}`, source: 'generated',
        provider: 'Alibaba Cloud:Qwen Image 3.0',
        metadata: { role: subject.role, subjectId: subject.id, frame, frameCount: subject.frames, frameMs: 180, derivedFrom: atlasPath, width, height,
          targetFps: 60, sourceAnimationFps: 1000 / 180, durationMs: subject.frames * 180, timingMode: 'time-based', variant: 'shared-60fps', animationGroup: subject.id },
      });
      paths.push(`./${relativePath.slice('public/'.length)}`);
    }
    result.push({ subjectId: subject.id, role: subject.role, paths, width, height, frameMs: 180,
      targetFps: 60, sourceAnimationFps: 1000 / 180, durationMs: subject.frames * 180, timingMode: 'time-based' });
  }
  return result;
}

/** Normalize copied working assets only; callers keep published files intact. */
export async function normalizeSubjectFrames(root: string, projectId: string, assets: ProductionAsset[]): Promise<ProductionAsset[]> {
  const store = new AssetStore();
  const registered = new Map((await store.list(projectId, root)).map((asset) => [asset.relativePath, asset]));
  const result: ProductionAsset[] = [];
  const publicRoot = resolve(root, 'public');
  for (const asset of assets) {
    if (asset.role === 'background') { result.push(asset); continue; }
    const paths = asset.paths.map((path) => {
      const target = resolve(publicRoot, path);
      const inside = relative(publicRoot, target);
      if (isAbsolute(inside) || inside.startsWith('..')) throw new Error('复用素材路径不在项目目录中。');
      return { target, relativePath: `public/${inside.split('\\').join('/')}` };
    });
    const frames = await Promise.all(paths.map(async ({ target }) => PNG.sync.read(await readFile(target))));
    const cropped = cropSubjectFrames(frames, asset.subjectId);
    const { width, height } = cropped[0];
    const { paths: _paths, width: _width, height: _height, ...attributes } = asset;
    for (const [frame, image] of cropped.entries()) {
      const { target, relativePath } = paths[frame];
      const original = registered.get(relativePath);
      if (image !== frames[frame]) await writeFile(target, PNG.sync.write(image));
      await store.registerExisting({
        projectId, root, relativePath,
        name: original?.name, source: original?.source ?? 'procedural', prompt: original?.prompt, provider: original?.provider,
        metadata: { ...original?.metadata, ...attributes, frame, frameCount: frames.length, width, height },
      });
    }
    result.push({ ...asset, width, height });
  }
  return result;
}

function cropSubjectFrames(frames: PNG[], subjectId: string): PNG[] {
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  for (const image of frames) {
    let visible = 0;
    for (let pixel = 0; pixel < image.width * image.height; pixel++) {
      if (!image.data[pixel * 4 + 3]) continue;
      visible++;
      left = Math.min(left, pixel % image.width);
      top = Math.min(top, Math.floor(pixel / image.width));
      right = Math.max(right, pixel % image.width);
      bottom = Math.max(bottom, Math.floor(pixel / image.width));
    }
    if (visible < image.width * image.height * 0.01) throw new Error(`素材 ${subjectId} 的动画帧为空，需要重新绘制。`);
  }
  if (!frames.length) throw new Error(`素材 ${subjectId} 的动画帧为空，需要重新绘制。`);
  const padding = 2;
  const width = right - left + 1 + padding * 2;
  const height = bottom - top + 1 + padding * 2;
  return frames.map((source) => {
    if (left === padding && top === padding && source.width === width && source.height === height) return source;
    const image = new PNG({ width, height });
    image.data.fill(0);
    // Copy pixels without scaling, using one source origin for every pose.
    for (let y = top; y <= bottom && y < source.height; y++) {
      const end = Math.min(right + 1, source.width);
      source.data.copy(image.data, ((y - top + padding) * width + padding) * 4,
        (y * source.width + left) * 4, (y * source.width + end) * 4);
    }
    return image;
  });
}

export function clearEdgeWhite(image: PNG): void {
  const { width, height, data } = image;
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  const push = (pixel: number) => {
    if (visited[pixel]) return;
    visited[pixel] = 1;
    const offset = pixel * 4;
    if (data[offset] >= 240 && data[offset + 1] >= 240 && data[offset + 2] >= 240) {
      queue.push(pixel);
      data[offset + 3] = 0;
    }
  };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  for (let index = 0; index < queue.length; index++) {
    const pixel = queue[index];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x) push(pixel - 1);
    if (x + 1 < width) push(pixel + 1);
    if (y) push(pixel - width);
    if (y + 1 < height) push(pixel + width);
  }
}
