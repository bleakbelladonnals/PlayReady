import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { AssetStore } from '../../main/assetStore.js';
import { normalizeSubjectFrames, splitGameAtlas, type ProductionAsset, type VisualSubject } from './art.js';

const atlasPath = 'public/assets/images/source.png';
const subject = (id: string, frames = 1): VisualSubject => ({ id, frames, role: 'object', description: id });

function whiteAtlas(width: number, height: number): PNG {
  const image = new PNG({ width, height });
  image.data.fill(255);
  return image;
}
function paint(image: PNG, x: number, y: number, width: number, height: number, color = [30, 90, 150, 255]): void {
  for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) {
    image.data.set(color, (row * image.width + column) * 4);
  }
}
function pixel(image: PNG, x: number, y: number): number[] {
  return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x + 1) * 4)];
}
async function saveAtlas(root: string, image: PNG): Promise<Buffer> {
  await mkdir(join(root, 'public/assets/images'), { recursive: true });
  const bytes = PNG.sync.write(image);
  await writeFile(join(root, atlasPath), bytes);
  return bytes;
}
async function readFrame(root: string, path: string): Promise<PNG> {
  return PNG.sync.read(await readFile(join(root, 'public', path)));
}

describe('game atlas subject cropping', () => {
  it('removes cell margins, keeps transparent padding and enclosed white pixels, and registers actual dimensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-art-padding-'));
    try {
      const atlas = whiteAtlas(128, 128);
      paint(atlas, 40, 44, 48, 40);
      paint(atlas, 60, 58, 8, 8, [255, 255, 255, 255]);
      const original = await saveAtlas(root, atlas);
      const [asset] = await splitGameAtlas(root, 'art-padding', atlasPath, [subject('player')], 1, 1);
      expect([asset.width, asset.height]).toEqual([52, 44]);
      const frame = await readFrame(root, asset.paths[0]);
      expect([frame.width, frame.height]).toEqual([asset.width, asset.height]);
      for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
        expect(pixel(frame, x, y)[3]).toBe(x < 2 || x >= 50 || y < 2 || y >= 42 ? 0 : 255);
      }
      expect(pixel(frame, 22, 16)).toEqual([255, 255, 255, 255]);
      const manifest = JSON.parse(await readFile(join(root, 'public/assets/asset-pack.json'), 'utf8'));
      expect(manifest.assets[0].metadata).toMatchObject({ width: 52, height: 44, derivedFrom: atlasPath });
      expect(await readFile(join(root, atlasPath))).toEqual(original);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses one union crop for both poses without changing their pixel scale or shared anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-art-poses-'));
    try {
      const atlas = whiteAtlas(256, 128);
      paint(atlas, 44, 40, 32, 40);
      paint(atlas, 128 + 40, 36, 40, 48, [160, 70, 20, 255]);
      // Same source-coordinate landmark in each pose proves preserved alignment.
      paint(atlas, 60, 60, 4, 4, [20, 180, 70, 255]);
      paint(atlas, 128 + 60, 60, 4, 4, [20, 180, 70, 255]);
      await saveAtlas(root, atlas);
      const [asset] = await splitGameAtlas(root, 'art-poses', atlasPath, [subject('player', 2)], 2, 1);
      expect([asset.width, asset.height]).toEqual([44, 52]);
      const frames = await Promise.all(asset.paths.map((path) => readFrame(root, path)));
      for (const frame of frames) {
        expect([frame.width, frame.height]).toEqual([44, 52]);
        expect(pixel(frame, 22, 26)).toEqual([20, 180, 70, 255]);
        expect(pixel(frame, 25, 29)).toEqual([20, 180, 70, 255]);
        expect(pixel(frame, 26, 29)).not.toEqual([20, 180, 70, 255]);
      }
      expect(pixel(frames[0], 2, 2)[3]).toBe(0);
      expect(pixel(frames[0], 6, 6)).toEqual([30, 90, 150, 255]);
      expect(pixel(frames[1], 2, 2)).toEqual([160, 70, 20, 255]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports wide paddle and brick proportions instead of their square atlas cells', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-art-wide-props-'));
    try {
      const atlas = whiteAtlas(1024, 512);
      paint(atlas, 56, 216, 400, 80);
      paint(atlas, 512 + 139, 211, 234, 90);
      await saveAtlas(root, atlas);
      const [paddle, brick] = await splitGameAtlas(root, 'art-props', atlasPath, [subject('paddle'), subject('brick')], 2, 1);
      expect([paddle.width, paddle.height]).toEqual([404, 84]);
      expect([brick.width, brick.height]).toEqual([238, 94]);
      expect(paddle.width / paddle.height).toBeGreaterThan(4.7);
      expect(brick.width / brick.height).toBeGreaterThan(2.5);
      const paddleFrame = await readFrame(root, paddle.paths[0]);
      expect(pixel(paddleFrame, 2, 2)).toEqual([30, 90, 150, 255]);
      expect(pixel(paddleFrame, 401, 81)).toEqual([30, 90, 150, 255]);
      expect(pixel(paddleFrame, 402, 81)[3]).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('normalizes old transparent frames in place, preserves their origins and timing, skips backgrounds, and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-art-reuse-'));
    try {
      await mkdir(join(root, 'public/assets/images'), { recursive: true });
      const paths = ['./assets/images/player-0.png', './assets/images/player-1.png'];
      const first = new PNG({ width: 128, height: 128 }); first.data.fill(0);
      const second = new PNG({ width: 128, height: 128 }); second.data.fill(0);
      paint(first, 44, 40, 32, 40);
      paint(second, 40, 36, 40, 48, [160, 70, 20, 255]);
      const store = new AssetStore();
      for (const [frame, image] of [first, second].entries()) {
        const relativePath = `public/assets/images/player-${frame}.png`;
        await writeFile(join(root, relativePath), PNG.sync.write(image));
        await store.registerExisting({
          projectId: 'art-reuse', root, relativePath, source: 'imported', provider: 'original-provider', prompt: 'original-prompt',
          metadata: { role: 'player', subjectId: 'player', frame, derivedFrom: atlasPath, targetFps: 60,
            sourceAnimationFps: 5, durationMs: 400, timingMode: 'time-based', variant: 'original-60fps', animationGroup: 'player' },
        });
      }
      const backgroundBytes = PNG.sync.write(whiteAtlas(128, 128));
      await writeFile(join(root, 'public/assets/images/background.png'), backgroundBytes);
      const assets: ProductionAsset[] = [
        { subjectId: 'background', role: 'background', paths: ['./assets/images/background.png'], width: 128, height: 128, frameMs: 0 },
        { subjectId: 'player', role: 'player', paths, width: 128, height: 128, frameMs: 200,
          targetFps: 60, sourceAnimationFps: 5, durationMs: 400, timingMode: 'time-based' },
      ];
      const normalized = await normalizeSubjectFrames(root, 'art-reuse', assets);
      expect(normalized[0]).toEqual(assets[0]);
      expect(normalized[1]).toEqual({ ...assets[1], width: 44, height: 52 });
      expect(assets[1].width).toBe(128);
      expect(await readFile(join(root, 'public/assets/images/background.png'))).toEqual(backgroundBytes);
      const records = await store.list('art-reuse', root);
      for (const path of paths) {
        const record = records.find((record) => record.relativePath === `public/${path.slice(2)}`)!;
        expect(record).toMatchObject({ source: 'imported', provider: 'original-provider', prompt: 'original-prompt' });
        expect(record.metadata).toMatchObject({ width: 44, height: 52, derivedFrom: atlasPath, frameMs: 200,
          targetFps: 60, sourceAnimationFps: 5, durationMs: 400, timingMode: 'time-based', variant: 'original-60fps', animationGroup: 'player' });
      }
      const before = await Promise.all(paths.map(path => readFile(join(root, 'public', path))));
      expect(await normalizeSubjectFrames(root, 'art-reuse', normalized)).toEqual(normalized);
      const after = await Promise.all(paths.map(path => readFile(join(root, 'public', path))));
      expect(after).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
