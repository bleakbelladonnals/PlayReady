import type { ClassicDefinition } from './classicRuntime.js';

export const snakeDefinition: ClassicDefinition = {
  kind: 'snake',
  title: '像素贪吃蛇',
  width: 600,
  height: 600,
  subjects: { player: ['snake', 'player', 'snake-head'], food: ['food', 'apple', 'pickup'] },
  controls: '方向键转向 · P暂停 · R重开',
  code: `
const columns = 30, rows = 30, cell = api.width / columns, stepSeconds = 0.38;
let snake, food, direction, pendingDirection, elapsed, age, eaten, ended;

function reset() {
  snake = [{x:3,y:14},{x:2,y:14},{x:1,y:14}];
  direction = {x:1,y:0};
  pendingDirection = direction;
  food = {x:5,y:14};
  elapsed = 0; age = 0; eaten = 0; ended = false;
  api.status('方向键转向，吃食物长大，避免撞墙或撞到自己');
}
function placeFood() {
  const free = [];
  for (let y=0;y<rows;y++) for (let x=0;x<columns;x++) {
    if (!snake.some(part => part.x===x && part.y===y)) free.push({x,y});
  }
  if (!free.length) {
    ended = true;
    api.finish('游戏结束：你已经填满棋盘，太棒了！');
    return;
  }
  food = free[Math.floor(Math.random()*free.length)];
}
function advance() {
  const next = {x:snake[0].x+direction.x,y:snake[0].y+direction.y};
  if (next.x<0 || next.x>=columns || next.y<0 || next.y>=rows) {
    ended = true; api.finish('游戏结束：撞到墙了，按 R 再来一局'); return;
  }
  const grows = next.x===food.x && next.y===food.y;
  const occupied = grows ? snake : snake.slice(0,-1);
  if (occupied.some(part => part.x===next.x && part.y===next.y)) {
    ended = true; api.finish('游戏结束：撞到自己了，按 R 再来一局'); return;
  }
  snake.unshift(next);
  if (grows) {
    eaten++; api.score(10); placeFood();
  } else snake.pop();
  if (ended) return;
  direction = pendingDirection;
  api.status(eaten ? '吃到食物！已吃 '+eaten+' 个，继续转向收集' : '方向键转向，吃食物长大，避免撞墙或撞到自己');
}
function update(dt) {
  if (ended) return;
  age += dt; elapsed += dt;
  while (elapsed>=stepSeconds && !ended) {
    elapsed -= stepSeconds; advance();
  }
}
function key(code) {
  const choices = {ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1},ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0}};
  const next = choices[code];
  if (next && (next.x!==-direction.x || next.y!==-direction.y)) pendingDirection = next;
}
function drawImage(ctx, role, cx, cy, size) {
  const count = api.images(role).length;
  const image = api.image(role, count>1 ? Math.floor(age/0.18)%count : 0);
  const ratio = image.naturalWidth / image.naturalHeight;
  const width = ratio>=1 ? size : size*ratio;
  const height = ratio>=1 ? size/ratio : size;
  ctx.drawImage(image,cx-width/2,cy-height/2,width,height);
}
function draw(ctx) {
  // A translucent grid leaves the supplied environment visible underneath.
  ctx.strokeStyle='rgba(67,116,93,0.13)'; ctx.lineWidth=1;
  ctx.beginPath();
  for (let x=0;x<=columns;x++) {ctx.moveTo(x*cell,0);ctx.lineTo(x*cell,api.height);}
  for (let y=0;y<=rows;y++) {ctx.moveTo(0,y*cell);ctx.lineTo(api.width,y*cell);}
  ctx.stroke();
  const phase = ended ? 0 : elapsed/stepSeconds;
  for (let i=snake.length-1;i>=1;i--) {
    const part=snake[i], target=snake[i-1];
    const x=(part.x+(target.x-part.x)*phase+0.5)*cell;
    const y=(part.y+(target.y-part.y)*phase+0.5)*cell;
    ctx.fillStyle=i%2 ? '#4b9981' : '#62ac8e';
    ctx.fillRect(x-cell*0.41,y-cell*0.41,cell*0.82,cell*0.82);
    ctx.fillStyle='rgba(228,250,233,0.35)';
    ctx.fillRect(x-cell*0.30,y-cell*0.30,cell*0.25,cell*0.13);
  }
  drawImage(ctx,'food',(food.x+0.5)*cell,(food.y+0.5)*cell,cell*(0.88+0.04*Math.sin(age*4)));
  const head=snake[0];
  drawImage(ctx,'player',(head.x+direction.x*phase+0.5)*cell,(head.y+direction.y*phase+0.5)*cell,cell*0.96);
}
reset();
return {reset,update,draw,key};
`,
  journey: [
    { id: 'ready', action: 'launch', inputs: [{ type: 'wait', ms: 200 }], capture: 'ready.png', observe: [
      { kind: 'canvas-not-blank', description: '蛇和首个食物在棋盘上可见' },
      { kind: 'text-visible', description: '开始页显示游戏标题', value: '像素贪吃蛇' },
    ] },
    { id: 'started', action: 'start', inputs: [{ type: 'key', code: 'Enter', holdMs: 80 }, { type: 'wait', ms: 300 }], capture: 'started.png', observe: [
      { kind: 'screen-change', description: '开始后蛇沿棋盘前进', baselineStepId: 'ready' },
    ] },
    { id: 'paused', action: 'pause', inputs: [{ type: 'key', code: 'KeyP', holdMs: 80 }], capture: 'paused.png', observe: [
      { kind: 'text-visible', description: '暂停状态清楚可辨', value: '已暂停' },
    ] },
    { id: 'resumed', action: 'pause', inputs: [{ type: 'key', code: 'KeyP', holdMs: 80 }, { type: 'wait', ms: 800 }], capture: 'resumed.png', observe: [
      { kind: 'text-hidden', description: '恢复后暂停提示消失', value: '已暂停', baselineStepId: 'paused' },
      { kind: 'screen-change', description: '恢复后蛇继续真实前进', baselineStepId: 'paused' },
    ] },
    { id: 'progress', action: 'wait', inputs: [{ type: 'wait', ms: 100 }], capture: 'progress.png', observe: [
      { kind: 'text-visible', description: '蛇已吃到前方食物并增长，分数增加', value: '吃到食物' },
    ] },
    { id: 'moved', action: 'move', inputs: [{ type: 'key', code: 'ArrowDown', holdMs: 400 }], capture: 'moved.png', observe: [
      { kind: 'screen-change', description: '方向键令蛇向下转弯', baselineStepId: 'progress' },
    ] },
    { id: 'turned', action: 'primary', inputs: [{ type: 'key', code: 'ArrowRight', holdMs: 400 }], capture: 'turned.png', observe: [
      { kind: 'screen-change', description: '再次转向令蛇向右前进', baselineStepId: 'moved' },
    ] },
    { id: 'terminal', action: 'wait', inputs: [{ type: 'wait', ms: 9000 }], capture: 'terminal.png', observe: [
      { kind: 'text-visible', description: '持续向右到达墙壁触发真实碰撞结束', value: '游戏结束' },
    ] },
    { id: 'restarted', action: 'restart', inputs: [{ type: 'key', code: 'KeyR', holdMs: 80 }], capture: 'restarted.png', observe: [
      { kind: 'screen-change', description: '重开恢复初始蛇、食物和菜单', baselineStepId: 'terminal' },
      { kind: 'text-visible', description: '重开后游戏标题可见', value: '像素贪吃蛇' },
      { kind: 'text-hidden', description: '重开清除游戏结束提示', value: '游戏结束', baselineStepId: 'terminal' },
    ] },
  ],
  success: [
    { kind: 'text-visible', description: '重开后进入正常可开始页面', value: '像素贪吃蛇' },
    { kind: 'text-hidden', description: '已结束状态不残留在重开页面', value: '游戏结束', baselineStepId: 'terminal' },
    { kind: 'canvas-not-blank', description: '重开后的蛇与食物仍可见' },
  ],
};
