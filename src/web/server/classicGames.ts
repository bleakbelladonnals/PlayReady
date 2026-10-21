import { flappyDefinition } from './classicFlappy.js';
import { snakeDefinition } from './classicSnake.js';
import { breakoutDefinition } from './classicBreakout.js';
import type { ClassicDefinition } from './classicRuntime.js';

/** Reuse bounded production mechanics for recognizable simple requests.
 * Specific extensions still use the ordinary model implementation workflow. */
export function classicDefinition(prompt: string, change: string | null | undefined): ClassicDefinition | null {
  if (prompt.length > 100 || /增加|加入|双人|联网|3D|倒计时|限时|(?:\d+)\s*秒|自定义/u.test(prompt)) return null;
  if (change && (!/修复|继续(?:制作|完成)|恢复/u.test(change) || /增加|加入|双人|联网|改成|更换|倒计时|限时|自定义/u.test(change))) return null;
  const matches = [
    /flappy\s*bird|flypy\s*bird|flappybird|飞鸟|飞翔的小鸟/iu.test(prompt) ? flappyDefinition : null,
    /贪吃蛇|\bsnake\b/iu.test(prompt) ? snakeDefinition : null,
    /打砖块|\bbreakout\b/iu.test(prompt) ? breakoutDefinition : null,
  ].filter((item): item is ClassicDefinition => item !== null);
  return matches.length === 1 ? matches[0]! : null;
}
