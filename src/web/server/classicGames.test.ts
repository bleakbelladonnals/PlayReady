import { describe, expect, it } from 'vitest';
import { classicDefinition } from './classicGames.js';

describe('recognizable production mechanics', () => {
  it('handles a short ordinary request and repair without changing its game family', () => {
    expect(classicDefinition('帮我做一个类似flypybird的游戏', null)?.kind).toBe('flappy');
    expect(classicDefinition('做一个像素贪吃蛇小游戏', '修复上次制作中断，保留原来的核心玩法和已生成素材，完成制作与试玩。')?.kind).toBe('snake');
    expect(classicDefinition('做一个像素打砖块小游戏', null)?.kind).toBe('breakout');
  });

  it('keeps unrelated ideas, combined mechanics and new requirements in the general workflow', () => {
    for (const prompt of ['用方向键接住金币', '贪吃蛇与打砖块结合', '加入联网模式的贪吃蛇', '30秒限时打砖块']) {
      expect(classicDefinition(prompt, null)).toBeNull();
    }
    for (const change of ['标题改为蛇蛇历险记', '修复并加入双人操作', '修复并改成接金币', '更换角色']) {
      expect(classicDefinition('做一个贪吃蛇', change)).toBeNull();
    }
  });
});
