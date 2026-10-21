import type { GameplayPlaytestManifest } from '../../main/gameplayExperienceEvaluator.js';
import type { ProductionAsset } from './art.js';

export interface ClassicDefinition {
  kind: 'flappy' | 'snake' | 'breakout';
  title: string;
  width: number;
  height: number;
  subjects: Record<string, string[]>;
  controls: string;
  code: string;
  journey: GameplayPlaytestManifest['journey'];
  success: GameplayPlaytestManifest['success'];
}
export interface ClassicOutput {
  title: string; html: string; css: string; js: string; playtest: GameplayPlaytestManifest;
}

export function classicAssets(definition: ClassicDefinition, assets: ProductionAsset[]): Record<string, ProductionAsset> | null {
  const chosen: Record<string, ProductionAsset> = {};
  const background = assets.find(asset => asset.role === 'background');
  if (!background) return null;
  chosen.background = background;
  for (const [role, names] of Object.entries(definition.subjects)) {
    const asset = assets.find(asset => asset.role !== 'background' && names.some(name => asset.subjectId === name))
      ?? assets.find(asset => asset.role !== 'background' && names.some(name => asset.subjectId.includes(name)))
      ?? assets.find(asset => asset.role === (role === 'food' ? 'pickup' : role === 'obstacle' ? 'object' : role));
    if (!asset || Object.values(chosen).includes(asset)) return null;
    chosen[role] = asset;
  }
  return chosen;
}

export function buildClassicOutput(definition: ClassicDefinition, selected: Record<string, ProductionAsset>): ClassicOutput {
  const title = definition.title;
  const paths = Object.fromEntries(Object.entries(selected).map(([role, asset]) => [role, asset.paths]));
  const html = `<main class="game-root" data-game-root><header><strong>${title}</strong><span id="score">得分：0</span><button id="pause-button" type="button">暂停</button></header><div class="scene"><canvas id="game" width="${definition.width}" height="${definition.height}"></canvas><section id="ready" class="overlay"><h1>${title}</h1><p>${definition.controls}</p><p id="loading">画面载入中…</p><button id="start-button" type="button" disabled>开始游戏</button></section><section id="paused" class="overlay" hidden><h2>已暂停</h2><button id="resume-button" type="button">继续游戏</button></section><section id="terminal" class="overlay" hidden><h2>游戏结束</h2><p id="result"></p><button id="restart-button" type="button">重新开始</button></section></div><footer><span>${definition.controls}</span><span id="status"></span></footer></main>`;
  const css = `*{box-sizing:border-box}body{margin:0;background:#edf4ef;color:#234339;font-family:system-ui,"Noto Sans CJK SC",sans-serif;display:grid;place-items:center;min-height:100vh}.game-root{width:min(100vw,${definition.width}px,calc((100dvh - 104px) * ${definition.width / definition.height}))}header,footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:#f6faf7}header strong{font-size:18px}footer{font-size:13px;min-height:40px}.scene{position:relative;aspect-ratio:${definition.width}/${definition.height};overflow:hidden}canvas{display:block;width:100%;height:100%;image-rendering:pixelated}.overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:16px;background:rgba(237,246,239,.92);padding:24px}.overlay[hidden]{display:none}h1,h2,p{margin:0}h1{font-size:36px}h2{font-size:30px}button{font:inherit;font-weight:700;background:#387a60;color:white;border:0;padding:12px 24px;cursor:pointer}button:disabled{opacity:.45;cursor:wait}header button{padding:7px 14px}button:focus-visible{outline:3px solid #d9a942;outline-offset:3px}`;
  const js = `(() => {
'use strict';
const canvas=document.getElementById('game'),ctx=canvas.getContext('2d');
const W=canvas.width,H=canvas.height,paths=${JSON.stringify(paths)},pictures={};
const ready=document.getElementById('ready'),paused=document.getElementById('paused'),terminal=document.getElementById('terminal');
const scoreNode=document.getElementById('score'),statusNode=document.getElementById('status'),result=document.getElementById('result');
let state='ready',loaded=false,points=0,last=0;
function image(role,index=0){const list=pictures[role]||[];return list[index%list.length];}
function drawSprite(c,role,x,y,w,h,index=0){const img=image(role,index);if(!img||!img.naturalWidth)return;const ratio=img.naturalHeight/img.naturalWidth;if(h===undefined)h=w*ratio;const scale=Math.min(w/img.naturalWidth,h/img.naturalHeight);const dw=img.naturalWidth*scale,dh=img.naturalHeight*scale;c.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);}
const api={width:W,height:H,images:role=>pictures[role]||[],image,drawSprite,
score(n){points+=n;scoreNode.textContent='得分：'+points;},
status(text){statusNode.textContent=text;},
finish(message){if(state!=='playing')return;state='over';result.textContent=message+' · 得分：'+points;sync();}};
function createGame(api){${definition.code}\n}
const game=createGame(api);
function sync(){ready.hidden=state!=='ready';paused.hidden=state!=='paused';terminal.hidden=state!=='over';statusNode.hidden=state!=='playing';document.getElementById('pause-button').disabled=state!=='playing'&&state!=='paused';document.getElementById('pause-button').textContent=state==='paused'?'继续':'暂停';}
function reset(){state='ready';points=0;scoreNode.textContent='得分：0';statusNode.textContent='';game.reset();sync();}
function start(){if(!loaded)return;if(state==='ready'||state==='over'){reset();state='playing';sync();}}
function togglePause(){if(state==='playing')state='paused';else if(state==='paused')state='playing';sync();}
function input(code,repeat=false){if(code==='KeyP'){if(!repeat)togglePause();return;}if(code==='KeyR'){if(!repeat)reset();return;}if(code==='Enter'){if(!repeat)start();return;}if(state==='ready'&&(code==='Space'||code.startsWith('Arrow')))start();if(state==='playing')game.key(code);}
window.addEventListener('keydown',event=>{if(['Enter','Space','KeyP','KeyR','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.code)){event.preventDefault();input(event.code,event.repeat);}});
window.addEventListener('keyup',event=>{game.keyUp?.(event.code);});
window.addEventListener('blur',()=>{for(const code of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'])game.keyUp?.(code);});
canvas.addEventListener('pointerdown',event=>{event.preventDefault();input('Space');game.keyUp?.('Space');});
document.getElementById('start-button').addEventListener('click',start);document.getElementById('resume-button').addEventListener('click',togglePause);document.getElementById('pause-button').addEventListener('click',togglePause);document.getElementById('restart-button').addEventListener('click',reset);
function background(){const img=image('background');if(!img)return;const scale=Math.max(W/img.naturalWidth,H/img.naturalHeight),dw=img.naturalWidth*scale,dh=img.naturalHeight*scale;ctx.drawImage(img,(W-dw)/2,(H-dh)/2,dw,dh);}
function tick(now){const dt=Math.min(.05,Math.max(0,(now-last)/1000));last=now;if(loaded){if(state==='playing')game.update(dt);ctx.clearRect(0,0,W,H);background();game.draw(ctx);}requestAnimationFrame(tick);}
Promise.all(Object.entries(paths).map(async([role,list])=>{pictures[role]=await Promise.all(list.map(src=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('画面素材载入失败'));img.src=src;})));})).then(()=>{loaded=true;reset();document.getElementById('loading').textContent='';document.getElementById('start-button').disabled=false;}).catch(error=>{document.getElementById('loading').textContent=error.message;console.error(error.message);});
requestAnimationFrame(tick);
})();`;
  const key = (code: string) => ({ type: 'key' as const, code, holdMs: 50 });
  const actions = Object.fromEntries(['start', 'move', 'primary', 'pause', 'restart'].map(action => [action, { inputs: [key(action === 'start' ? 'Enter' : action === 'restart' ? 'KeyR' : action === 'pause' ? 'KeyP' : 'Space')] }])) as unknown as GameplayPlaytestManifest['actions'];
  return { title, html, css, js, playtest: { schemaVersion:1, updatedAt:new Date().toISOString(),engine:'web',entrypoint:{path:'public/index.html',readyTimeoutMs:15000},actions,journey:definition.journey,success:definition.success,limits:{maxRunMs:120000,stepTimeoutMs:20000}} };
}
