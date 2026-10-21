import type { ClassicDefinition } from './classicRuntime.js';

const key = (code: string) => ({ type: 'key' as const, code, holdMs: 16 });
const flight = [{ code: 'Space', intervalMs: 610 }];

export const flappyDefinition: ClassicDefinition = {
  kind: 'flappy',
  title: '飞鸟闯关',
  width: 960,
  height: 540,
  subjects: {
    player: ['bird-player', 'bird', 'player'],
    obstacle: ['pipe-obstacle', 'pipe', 'obstacle'],
  },
  controls: '空格/↑拍翅 · P暂停 · R重开',
  code: `
const W=api.width,H=api.height,BIRD_X=W*.25,BIRD_RADIUS=17,PIPE_WIDTH=86,GAP=190,FLOOR=H-32;
let birdY=H*.5,velocity=0,wingTime=0,pipes=[],points=0,ended=false,launched=false,nextPipe=0;
function makePipe(x,index){
  // The first two openings are centred; later ones vary gently as play advances.
  const centre=H*.5+(index<2?0:Math.sin(index*1.7)*38);
  return {x,top:centre-GAP/2,bottom:centre+GAP/2,scored:false};
}
function reset(){
  birdY=H*.5;velocity=0;wingTime=0;points=0;ended=false;launched=false;nextPipe=3;
  pipes=[0,1,2].map(index=>makePipe(W+28+index*360,index));
  api.status('空格/↑拍翅起飞');
}
function end(message){if(ended)return;ended=true;api.finish(message);}
function key(code){
  if(!ended&&(code==='Space'||code==='ArrowUp')){launched=true;velocity=-270;wingTime=0;}
}
function update(dt){
  if(ended||!launched)return;
  // Exact constant-acceleration integration keeps the flight independent of FPS.
  birdY+=velocity*dt+450*dt*dt;
  velocity+=900*dt;
  wingTime+=dt;
  if(birdY-BIRD_RADIUS<=0){birdY=BIRD_RADIUS;end('小鸟碰到了天空边缘');return;}
  if(birdY+BIRD_RADIUS>=FLOOR){birdY=FLOOR-BIRD_RADIUS;end('小鸟落到了地面');return;}
  const speed=100+Math.min(points*3,36);
  for(const pipe of pipes){
    pipe.x-=speed*dt;
    const overlaps=pipe.x<BIRD_X+BIRD_RADIUS&&pipe.x+PIPE_WIDTH>BIRD_X-BIRD_RADIUS;
    if(overlaps&&(birdY-BIRD_RADIUS<pipe.top||birdY+BIRD_RADIUS>pipe.bottom)){
      end('小鸟碰到了管道');return;
    }
    if(!pipe.scored&&pipe.x+PIPE_WIDTH<BIRD_X-BIRD_RADIUS){
      pipe.scored=true;points+=1;api.score(1);api.status('通过障碍');
    }
  }
  while(pipes.length&&pipes[0].x+PIPE_WIDTH<0)pipes.shift();
  if(pipes.length<3){const last=pipes[pipes.length-1];pipes.push(makePipe(last?last.x+360:W+28,nextPipe++));}
}
function pipePart(ctx,pipe,top){
  const img=api.image('obstacle',0);if(!img||!img.naturalWidth)return;
  const height=top?pipe.top:FLOOR-pipe.bottom;
  const width=Math.max(PIPE_WIDTH,height*img.naturalWidth/img.naturalHeight);
  ctx.save();ctx.beginPath();ctx.rect(pipe.x,top?0:pipe.bottom,PIPE_WIDTH,height);ctx.clip();
  if(top){ctx.translate(pipe.x+PIPE_WIDTH/2,pipe.top);ctx.scale(1,-1);}
  else ctx.translate(pipe.x+PIPE_WIDTH/2,pipe.bottom);
  // Scale uniformly, then crop the excess body; never squash a pipe sprite.
  api.drawSprite(ctx,'obstacle',-width/2,0,width);
  ctx.restore();
}
function draw(ctx){
  for(const pipe of pipes){pipePart(ctx,pipe,true);pipePart(ctx,pipe,false);}
  ctx.fillStyle='#79a96d';ctx.fillRect(0,FLOOR,W,H-FLOOR);
  ctx.fillStyle='#b9d39a';ctx.fillRect(0,FLOOR,W,5);
  const frames=api.images('player');
  const frame=frames.length?Math.floor(wingTime/.15)%frames.length:0;
  ctx.save();ctx.translate(BIRD_X,birdY);ctx.rotate(Math.max(-.45,Math.min(.8,velocity/600)));
  api.drawSprite(ctx,'player',-28,-23,56,46,frame);
  ctx.restore();
}
return {reset,update,draw,key};
`,
  journey: [
    { id: 'ready', action: 'launch', inputs: [], capture: 'ready.png', observe: [
      { kind: 'text-visible', description: '正常开始界面可见', value: '开始游戏' },
      { kind: 'canvas-not-blank', description: '小鸟与场景已显示' },
    ] },
    { id: 'start', action: 'start', inputs: [key('Enter')], sustain: flight, capture: 'start.png', observe: [
      { kind: 'screen-change', description: '开始真实飞行', baselineStepId: 'ready' },
      { kind: 'text-hidden', description: '开始界面关闭', value: '开始游戏', baselineStepId: 'ready' },
    ] },
    { id: 'paused', action: 'pause', inputs: [key('KeyP')], capture: 'paused.png', observe: [
      { kind: 'text-visible', description: '真实暂停界面出现', value: '已暂停' },
    ] },
    { id: 'resumed', action: 'pause', inputs: [key('KeyP'), { type: 'wait', ms: 700 }], sustain: flight, capture: 'resumed.png', observe: [
      { kind: 'screen-change', description: '恢复真实飞行', baselineStepId: 'paused' },
      { kind: 'text-hidden', description: '暂停界面关闭', value: '已暂停', baselineStepId: 'paused' },
    ] },
    { id: 'move', action: 'move', inputs: [key('Space')], sustain: flight, capture: 'move.png', observe: [
      { kind: 'screen-change', description: '拍翅改变小鸟飞行位置', baselineStepId: 'resumed' },
    ] },
    { id: 'primary', action: 'primary', inputs: [key('Space')], sustain: flight, capture: 'primary.png', observe: [
      { kind: 'screen-change', description: '继续拍翅维持飞行', baselineStepId: 'move' },
    ] },
    { id: 'progress', action: 'wait', inputs: [{ type: 'wait', ms: 7000 }], sustain: flight, capture: 'progress.png', observe: [
      { kind: 'text-visible', description: '真实穿过管道后获得进展', value: '通过障碍' },
    ] },
    { id: 'terminal', action: 'wait', inputs: [{ type: 'wait', ms: 2200 }], capture: 'terminal.png', observe: [
      { kind: 'text-visible', description: '停止拍翅后自然碰撞结束', value: '游戏结束' },
    ] },
    { id: 'restart', action: 'restart', inputs: [key('KeyR')], capture: 'restart.png', observe: [
      { kind: 'screen-change', description: '重开恢复正常开始界面', baselineStepId: 'terminal' },
      { kind: 'text-visible', description: '重开标题可见', value: '飞鸟闯关' },
      { kind: 'text-hidden', description: '结束界面关闭', value: '游戏结束', baselineStepId: 'terminal' },
    ] },
  ],
  success: [
    { kind: 'text-visible', description: '重开后可以再次开始', value: '开始游戏' },
    { kind: 'canvas-not-blank', description: '重开后小鸟与场景仍正常显示' },
  ],
};
