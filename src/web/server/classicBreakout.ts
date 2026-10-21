import type { ClassicDefinition } from './classicRuntime.js';

export const breakoutDefinition: ClassicDefinition = {
  kind: 'breakout',
  title: '像素打砖块',
  width: 960,
  height: 540,
  subjects: {
    player: ['paddle', 'player'],
    ball: ['ball'],
    brick: ['brick', 'block', 'object'],
  },
  controls: '方向键移动挡板 · P暂停 · R重开',
  code: String.raw`
    const W = api.width, H = api.height;
    const keys = new Set();
    const paddle = { x: 0, y: H - 50, w: 200, h: 20 };
    const ball = { x: 0, y: 0, vx: 22, vy: -140, r: 10 };
    let bricks = [], sparks = [], ended = false, hits = 0;
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    function reset() {
      keys.clear();
      ended = false; hits = 0; sparks = [];
      paddle.x = (W - paddle.w) / 2;
      ball.x = W / 2 - 40; ball.y = paddle.y - ball.r - 4;
      ball.vx = 22; ball.vy = -140;
      const cols = 9, gap = 12, bw = 84, bh = 24;
      const left = (W - cols * bw - (cols - 1) * gap) / 2;
      bricks = [];
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < cols; col++) {
          bricks.push({ x: left + col * (bw + gap), y: 72 + row * 32,
            w: bw, h: bh, row, alive: true, variant: col + row });
        }
      }
      api.status('接住小球，清除上方砖阵');
    }

    // Cover the rectangle with one uniformly scaled image, cropping excess edges.
    function texture(ctx, role, index, x, y, w, h) {
      const image = api.image(role, index);
      if (!image || !image.naturalWidth || !image.naturalHeight) return;
      const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
      const sw = w / scale, sh = h / scale;
      ctx.drawImage(image, (image.naturalWidth - sw) / 2,
        (image.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
    }

    function smash(brick) {
      brick.alive = false; hits++;
      api.score(10);
      api.status('击碎砖块 · ' + hits + ' / ' + bricks.length);
      for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4;
        sparks.push({ x: brick.x + brick.w / 2, y: brick.y + brick.h / 2,
          vx: Math.cos(angle) * 80, vy: Math.sin(angle) * 65, life: 0.45 });
      }
      if (hits === bricks.length) {
        ended = true;
        api.finish('全部砖块已清除！');
      }
    }

    function step(dt) {
      const direction = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0)
        - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
      paddle.x = clamp(paddle.x + direction * 420 * dt, 14, W - paddle.w - 14);
      const oldX = ball.x, oldY = ball.y;
      ball.x += ball.vx * dt; ball.y += ball.vy * dt;
      if (ball.x - ball.r < 14) {
        ball.x = 14 + ball.r; ball.vx = Math.abs(ball.vx);
      } else if (ball.x + ball.r > W - 14) {
        ball.x = W - 14 - ball.r; ball.vx = -Math.abs(ball.vx);
      }
      if (ball.y - ball.r < 22) {
        ball.y = 22 + ball.r; ball.vy = Math.abs(ball.vy);
      }
      if (ball.vy > 0 && oldY + ball.r <= paddle.y
          && ball.y + ball.r >= paddle.y
          && ball.x + ball.r > paddle.x && ball.x - ball.r < paddle.x + paddle.w) {
        ball.y = paddle.y - ball.r;
        const impact = clamp((ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2), -1, 1);
        const speed = Math.min(230, Math.hypot(ball.vx, ball.vy) + 4);
        const angle = impact * Math.PI / 3;
        ball.vx = Math.sin(angle) * speed;
        ball.vy = -Math.cos(angle) * speed;
      }
      for (const brick of bricks) {
        if (!brick.alive) continue;
        const nearX = clamp(ball.x, brick.x, brick.x + brick.w);
        const nearY = clamp(ball.y, brick.y, brick.y + brick.h);
        if ((ball.x - nearX) ** 2 + (ball.y - nearY) ** 2 > ball.r ** 2) continue;
        if (oldY - ball.r >= brick.y + brick.h) {
          ball.y = brick.y + brick.h + ball.r; ball.vy = Math.abs(ball.vy);
        } else if (oldY + ball.r <= brick.y) {
          ball.y = brick.y - ball.r; ball.vy = -Math.abs(ball.vy);
        } else if (oldX < brick.x) {
          ball.x = brick.x - ball.r; ball.vx = -Math.abs(ball.vx);
        } else {
          ball.x = brick.x + brick.w + ball.r; ball.vx = Math.abs(ball.vx);
        }
        smash(brick);
        break;
      }
      if (!ended && ball.y - ball.r > H) {
        ended = true;
        api.finish('小球落下了，再试一次！');
      }
    }

    function update(dt) {
      if (ended) return;
      const duration = clamp(dt, 0, 0.08);
      const steps = Math.max(1, Math.ceil(duration / 0.008));
      for (let i = 0; i < steps && !ended; i++) step(duration / steps);
      for (const spark of sparks) {
        spark.x += spark.vx * duration; spark.y += spark.vy * duration;
        spark.vy += 140 * duration; spark.life -= duration;
      }
      sparks = sparks.filter(spark => spark.life > 0);
    }

    function draw(ctx) {
      ctx.save();
      ctx.fillStyle = '#46647d';
      ctx.fillRect(10, 20, 4, H - 20); ctx.fillRect(W - 14, 20, 4, H - 20);
      ctx.fillRect(10, 18, W - 20, 4);
      const colors = ['#b7647b', '#c58b44', '#517f91'];
      for (const brick of bricks) {
        if (!brick.alive) continue;
        ctx.fillStyle = colors[brick.row]; ctx.fillRect(brick.x, brick.y, brick.w, brick.h);
        texture(ctx, 'brick', brick.variant, brick.x, brick.y, brick.w, brick.h);
        ctx.strokeStyle = '#f6f4ed'; ctx.lineWidth = 1;
        ctx.strokeRect(brick.x + 0.5, brick.y + 0.5, brick.w - 1, brick.h - 1);
      }
      ctx.fillStyle = '#1e5169'; ctx.fillRect(paddle.x, paddle.y, paddle.w, paddle.h);
      texture(ctx, 'player', 0, paddle.x, paddle.y, paddle.w, paddle.h);
      ctx.strokeStyle = '#f6f4ed'; ctx.lineWidth = 2;
      ctx.strokeRect(paddle.x + 1, paddle.y + 1, paddle.w - 2, paddle.h - 2);
      if (!ended) {
        ctx.fillStyle = '#f4ba4e'; ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2); ctx.fill();
        api.drawSprite(ctx, 'ball', ball.x - ball.r, ball.y - ball.r, ball.r * 2, ball.r * 2);
      }
      for (const spark of sparks) {
        ctx.globalAlpha = spark.life / 0.45; ctx.fillStyle = '#f4ba4e';
        ctx.fillRect(spark.x - 2, spark.y - 2, 4, 4);
      }
      ctx.restore();
    }

    return { reset, update, draw,
      key(code) { keys.add(code); },
      keyUp(code) { keys.delete(code); }
    };
  `,
  journey: [
    { id: 'ready', action: 'launch', inputs: [], capture: 'ready.png', observe: [
      { kind: 'canvas-not-blank', description: '真实砖阵与挡板可见' },
      { kind: 'text-visible', value: '像素打砖块', description: '开始菜单显示游戏标题' },
    ] },
    { id: 'start', action: 'start', inputs: [{ type: 'key', code: 'Enter', holdMs: 80 }], capture: 'start.png', observe: [
      { kind: 'screen-change', baselineStepId: 'ready', description: '开始后进入真实打砖块场景' },
    ] },
    { id: 'paused', action: 'pause', inputs: [{ type: 'key', code: 'KeyP', holdMs: 80 }], capture: 'paused.png', observe: [
      { kind: 'screen-change', baselineStepId: 'start', description: '暂停显示独立提示' },
      { kind: 'text-visible', value: '已暂停', description: '暂停提示可见' },
    ] },
    { id: 'resumed', action: 'pause', inputs: [{ type: 'key', code: 'KeyP', holdMs: 80 }], capture: 'resumed.png', observe: [
      { kind: 'screen-change', baselineStepId: 'paused', description: '恢复后继续运行' },
      { kind: 'text-hidden', baselineStepId: 'paused', value: '已暂停', description: '恢复后隐藏暂停提示' },
    ] },
    { id: 'move', action: 'move', inputs: [{ type: 'key', code: 'ArrowLeft', holdMs: 400 }], capture: 'move.png', observe: [
      { kind: 'screen-change', baselineStepId: 'resumed', description: '向左移动挡板接球' },
    ] },
    { id: 'primary', action: 'primary', inputs: [{ type: 'key', code: 'ArrowRight', holdMs: 400 }], capture: 'primary.png', observe: [
      { kind: 'screen-change', baselineStepId: 'move', description: '向右移动挡板改变接球位置' },
    ] },
    { id: 'progress', action: 'wait', inputs: [{ type: 'wait', ms: 700 }], capture: 'progress.png', observe: [
      { kind: 'text-visible', value: '击碎砖块', description: '小球真实击中砖块后记录进展' },
    ] },
    { id: 'terminal', action: 'wait', inputs: [
      { type: 'key', code: 'ArrowLeft', holdMs: 1600 },
      { type: 'wait', ms: 6000 }, { type: 'wait', ms: 6000 },
    ], capture: 'terminal.png', observe: [
      { kind: 'screen-change', baselineStepId: 'progress', description: '挡板移开后小球自然掉落，进入结束状态' },
      { kind: 'text-visible', value: '游戏结束', description: '真实掉球后显示结束菜单' },
    ] },
    { id: 'restart', action: 'restart', inputs: [{ type: 'key', code: 'KeyR', holdMs: 80 }], capture: 'restart.png', observe: [
      { kind: 'screen-change', baselineStepId: 'terminal', description: '重开恢复完整砖阵和开始菜单' },
      { kind: 'text-visible', value: '像素打砖块', description: '重开返回标题菜单' },
      { kind: 'text-hidden', baselineStepId: 'terminal', value: '游戏结束', description: '重开隐藏结束菜单' },
    ] },
  ],
  success: [
    { kind: 'canvas-not-blank', description: '重开后游戏画面仍正常' },
    { kind: 'text-visible', value: '像素打砖块', description: '一轮真实玩法后可回到开始菜单' },
    { kind: 'text-hidden', baselineStepId: 'terminal', value: '游戏结束', description: '重开清除上一轮结束状态' },
  ],
};
