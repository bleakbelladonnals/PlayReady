import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebState } from './state.js';

describe('public creation budget', () => {
  it('limits accepted projects to 20 per China calendar day', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludo-public-'));
    try {
      const state = new WebState(join(root, 'state.json'));
      await state.init();
      await expect(state.create('   ')).rejects.toMatchObject({ status: 400 });
      for (let index = 0; index < 20; index++) await state.create('一个简单的 2D 游戏');
      await expect(state.create('第二十一个游戏')).rejects.toMatchObject({ status: 429 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('project revisions', () => {
  it('retains a failed unpublished project after refresh and accepts only one concurrent modification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludo-failed-project-'));
    try {
      const file = join(root, 'state.json');
      const state = new WebState(file);
      await state.init();
      const { job, session } = await state.create('小狐狸接苹果');
      await state.update(job.id, 'failed', '制作中断', '修复后仍未通过试玩', '修复后仍未通过试玩');
      const refreshed = new WebState(file);
      await refreshed.init();
      expect(refreshed.authorized(job.id, session)).toMatchObject({ id: job.id, status: 'failed', hasPublished: false, revision: 0 });
      expect(refreshed.preview(job.id, job.previewToken)).toBeNull();
      await expect(refreshed.revise(job.id, 'different-browser', '保留角色')).rejects.toMatchObject({ status: 404 });
      const submissions = await Promise.allSettled([
        refreshed.revise(job.id, session, '保留现有画面，修复开始按钮'),
        refreshed.revise(job.id, session, '重复提交'),
      ]);
      expect(submissions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(submissions.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
      expect(refreshed.authorized(job.id, session)).toMatchObject({ prompt: '小狐狸接苹果', revision: 1, status: 'queued', hasPublished: false, changePrompt: '保留现有画面，修复开始按钮' });
      expect(refreshed.get(job.id)?.revisions).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('preserves the original brief, rejects concurrent revisions, and keeps published access after failure and restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludo-revisions-'));
    try {
      const file = join(root, 'state.json');
      const state = new WebState(file);
      await state.init();
      const { job, session } = await state.create( '原始游戏创意');
      await expect(state.revise(job.id, session, '修改')).rejects.toMatchObject({ status: 409 });
      await state.update(job.id, 'complete', '制作完成', '完成');
      await expect(state.revise(job.id, 'wrong-session', '修改')).rejects.toMatchObject({ status: 404 });
      const revised = await state.revise(job.id, session, '增加生命');
      expect(revised).toMatchObject({ prompt: '原始游戏创意', changePrompt: '增加生命', revision: 1, hasPublished: true, publishedRevision: 0 });
      const parallel = await Promise.allSettled([state.revise(job.id, session, '第二次修改'), state.revise(job.id, session, '第三次修改')]);
      expect(parallel.every((result) => result.status === 'rejected')).toBe(true);
      expect(state.preview(job.id, job.previewToken)).not.toBeNull();
      await state.update(job.id, 'failed', '制作中断', '未通过', '未通过');
      expect(state.preview(job.id, job.previewToken)).not.toBeNull();
      const next = await state.revise(job.id, session, '降低难度');
      expect(next.revision).toBe(2);
      expect(next.revisions?.map((item) => item.prompt)).toEqual(['增加生命', '降低难度']);
      const restarted = new WebState(file);
      await restarted.init();
      expect(restarted.authorized(job.id, session)).toMatchObject({ status: 'failed', revision: 2, publishedRevision: 0, hasPublished: true });
      expect(restarted.get(job.id)?.revisions?.[1]?.status).toBe('failed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('allows failed first productions to retry and counts revisions toward the shared daily budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludo-revision-budget-'));
    try {
      const state = new WebState(join(root, 'state.json'));
      await state.init();
      const { job, session } = await state.create( '原始游戏');
      await state.update(job.id, 'failed', '制作中断', '失败');
      for (let revision = 1; revision < 20; revision++) {
        const next = await state.revise(job.id, session, `第${revision}次补充要求`);
        expect(next.revision).toBe(revision);
        expect(next.hasPublished).toBe(false);
        await state.update(job.id, 'failed', '制作中断', '失败');
      }
      await expect(state.revise(job.id, session, '超额')).rejects.toMatchObject({ status: 429 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reads completed projects saved before revision fields were introduced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludo-legacy-state-'));
    try {
      const file = join(root, 'state.json');
      await writeFile(file, JSON.stringify({ version: 1, invites: [], jobs: [{ id: 'old', prompt: '旧项目', status: 'complete', stage: '制作完成', events: [], createdAt: new Date().toISOString(), sessionHash: 'hash', previewToken: 'token', error: null }] }));
      const state = new WebState(file);
      await state.init();
      expect(state.preview('old', 'token')).toMatchObject({ revision: 0, revisions: [], hasPublished: true, publishedRevision: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
