import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import type { GameplayJourneyAction, GameplayPlaytestManifest } from '../../main/gameplayExperienceEvaluator.js';
import { runWebPlaytest } from './playtest.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('server Chromium gameplay adapter', () => {
  it('keeps a real gravity game alive by repeated keyboard flaps during capture, while the same route without sustain naturally ends', async () => {
    const root = await createGame(`
      <canvas width="480" height="300"></canvas><p id="status">按回车开始</p>
      <script>
        const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),status=document.querySelector('#status');
        let state='ready',x=180,y=110,vy=0,last=performance.now(),elapsed=0;
        const keys=new Set();
        function reset(){state='ready';x=180;y=110;vy=0;elapsed=0;status.textContent='按回车开始';}
        window.addEventListener('keydown',event=>{
          event.preventDefault();keys.add(event.code);
          if(event.code==='Enter'&&state==='ready'){state='play';status.textContent='正在飞行';}
          if((event.code==='Space'||event.code==='ArrowUp')&&state==='play'&&!event.repeat)vy=-180;
          if(event.code==='Escape'&&!event.repeat){
            if(state==='play'){state='paused';status.textContent='暂停';}
            else if(state==='paused'){state='play';status.textContent='正在飞行';}
          }
          if(event.code==='KeyR'&&!event.repeat)reset();
        });
        window.addEventListener('keyup',event=>keys.delete(event.code));
        function frame(now){
          const dt=Math.min((now-last)/1000,0.05);last=now;
          if(state==='play'){
            elapsed+=dt;vy+=1000*dt;y+=vy*dt;
            if(keys.has('ArrowRight'))x=Math.min(440,x+140*dt);
            if(keys.has('ArrowLeft'))x=Math.max(40,x-140*dt);
            if(y>=260||y<=20){y=Math.max(20,Math.min(260,y));state='over';status.textContent='游戏结束';}
          }
          ctx.fillStyle=state==='ready'?'#c8ead6':'#b6dff4';ctx.fillRect(0,0,480,300);
          ctx.fillStyle='#528768';ctx.fillRect(0,280,480,20);
          ctx.fillStyle='#dc8554';ctx.beginPath();ctx.arc(x,y,20,0,Math.PI*2);ctx.fill();
          ctx.fillStyle='#fff8dc';ctx.beginPath();ctx.arc(x+5,y-5,7,0,Math.PI*2);ctx.fill();
          requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      </script>`);
    const manifest = createManifest();
    const sustain = [{ code: 'Space', intervalMs: 350 }];
    const key = (code: string, holdMs=0) => ({ type: 'key' as const, code, holdMs });
    const wait = (ms: number) => ({ type: 'wait' as const, ms });
    manifest.actions.move.inputs = [key('ArrowRight',600)];
    manifest.actions.primary.inputs = [key('ArrowUp'),wait(300)];
    manifest.journey = [
      { id:'ready',action:'launch',inputs:[],capture:'ready.png',observe:[{kind:'canvas-not-blank',description:'正常游戏菜单'}] },
      { id:'start',action:'start',inputs:[key('Enter'),wait(700)],sustain,capture:'start.png',observe:[{kind:'screen-change',description:'开始真实飞行',baselineStepId:'ready'}] },
      { id:'paused',action:'pause',inputs:[],capture:'paused.png',observe:[{kind:'text-visible',description:'暂停飞行',value:'暂停'}] },
      { id:'resumed',action:'pause',inputs:[key('Escape'),key('Space'),wait(700)],sustain,capture:'resumed.png',observe:[{kind:'screen-change',description:'恢复真实飞行',baselineStepId:'paused'}] },
      { id:'move',action:'move',inputs:[],sustain,capture:'move.png',observe:[{kind:'screen-change',description:'真实横向移动',baselineStepId:'resumed'}] },
      { id:'primary',action:'primary',inputs:[],sustain,capture:'primary.png',observe:[{kind:'screen-change',description:'向上拍翅',baselineStepId:'move'}] },
      { id:'flight',action:'wait',inputs:[wait(800)],sustain,capture:'flight.png',observe:[{kind:'text-visible',description:'正常控制后仍存活',value:'正在飞行'}] },
      { id:'restart',action:'restart',inputs:[],capture:'restart.png',observe:[{kind:'screen-change',description:'重开回到菜单',baselineStepId:'flight'}] },
    ];
    manifest.success = [{kind:'text-visible',description:'重开后的正常菜单',value:'按回车开始'}];
    await writeFile(join(root,'.ludoready/playtest.json'),JSON.stringify(manifest));
    const controlled = await runWebPlaytest(root);
    expect(controlled.errors).toEqual([]);
    expect(controlled.verdict,JSON.stringify({checks:controlled.checks,observations:controlled.observations,temporal:controlled.temporalSamples})).toBe('pass');
    expect(controlled.score).toBe(100);
    expect(controlled.observations.find((item)=>item.description==='正常控制后仍存活')?.status).toBe('pass');
    expect(controlled.temporalSamples.map((sample)=>sample.action)).toEqual(['resume','move','primary']);
    manifest.journey = manifest.journey.map(({sustain:_sustain,...step})=>step);
    await writeFile(join(root,'.ludoready/playtest.json'),JSON.stringify(manifest));
    const uncontrolled = await runWebPlaytest(root);
    expect(uncontrolled.errors).toEqual([]);
    expect(uncontrolled.verdict).toBe('repair');
    expect(uncontrolled.observations.find((item)=>item.description==='正常控制后仍存活')).toMatchObject({status:'repair',message:expect.stringContaining('游戏结束')});
    expect(uncontrolled.checks.find((check)=>check.id==='input-response')?.status).toBe('repair');
  }, 30_000);

  it('runs the same real gameplay checks through CDP with host-relayed assets', async () => {
    const portServer = createServer();
    await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve));
    const address = portServer.address();
    if (!address || typeof address === 'string') throw new Error('port unavailable');
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    const remote = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${address.port}`] });
    try {
      const root = await createGame(playableGame);
      const report = await runWebPlaytest(root, { cdpUrl: `http://127.0.0.1:${address.port}` });
      expect(report.errors).toEqual([]);
      expect(report.verdict, JSON.stringify(report.checks)).toBe('pass');
      expect(report.score).toBe(100);
      expect(report.temporalSamples.map((sample) => sample.action)).toEqual(['move', 'primary', 'resume']);
      expect((await readFile(join(root, report.screenshots.after!))).subarray(1, 4).toString()).toBe('PNG');
      expect(remote.isConnected()).toBe(true);
    } finally { await remote.close(); }
  }, 30_000);

  it('plays a real canvas game and publishes input, held animation, pause and restart evidence', async () => {
    const root = await createGame(playableGame);
    const manifest = createManifest();
    manifest.success = [...manifest.success, { kind: 'text-visible', description: '本地图片在预览策略下加载', value: '素材已载入' }];
    await writeFile(join(root, '.ludoready', 'playtest.json'), JSON.stringify(manifest));
    const report = await runWebPlaytest(root);
    expect(report.errors).toEqual([]);
    expect(report.verdict, JSON.stringify(report.checks)).toBe('pass');
    expect(report.score).toBe(100);
    expect(report.observations.find((item) => item.description === '本地图片在预览策略下加载')?.status).toBe('pass');
    expect(report.observations.find((item) => item.description === '暂停提示可见')?.status).toBe('pass');
    expect(report.temporalSamples.map((sample) => sample.action)).toEqual(['move', 'primary', 'resume']);
    expect(report.observations.find((item) => item.description === '暂停后玩法画面基本冻结')?.status).toBe('pass');
    const png = await readFile(join(root, report.screenshots.before!));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const saved = JSON.parse(await readFile(join(root, report.reportPath), 'utf8'));
    expect(saved.verdict).toBe('pass');
    expect(saved.entrypoint).toBe('public/index.html');
  }, 30_000);

  it('rejects real image stretching including cropped frames and transforms, while the same PNG at correct proportions passes', async () => {
    const correct = await createGame(imageRatioGame(false));
    const distorted = await createGame(imageRatioGame(true));
    const image = new PNG({ width: 512, height: 512 });
    for (let y = 80; y < 440; y++) {
      for (let x = 60; x < 196; x++) {
        const offset = (y * image.width + x) * 4;
        image.data[offset] = 234; image.data[offset + 1] = 175;
        image.data[offset + 2] = 39; image.data[offset + 3] = 255;
      }
    }
    const bytes = PNG.sync.write(image);
    await Promise.all([correct, distorted].map((root) => writeFile(join(root, 'public/sprite.png'), bytes)));
    const good = await runWebPlaytest(correct);
    expect(good.verdict, JSON.stringify(good.checks)).toBe('pass');
    const bad = await runWebPlaytest(distorted);
    expect(bad.errors).toEqual([]);
    expect(bad.verdict).toBe('repair');
    expect(bad.score).toBe(83);
    expect(bad.checks.map((check) => check.id)).toEqual(good.checks.map((check) => check.id));
    expect(bad.checks.filter((check) => check.status === 'repair').map((check) => check.id)).toEqual(['visible-surface']);
    const message = bad.checks.find((check) => check.id === 'visible-surface')!.message;
    expect(message).toContain('sprite.png');
    expect(message).toContain('源 256×512 → 目标 150×120');
    expect(message).toContain('比例偏差 150%');
    expect(message).toContain('建议宽 60 或高 300');
    expect(message).toContain('源 512×512 → 目标 60×30');
    expect(message).toContain('绘图缩放 2×1');
    const saved = JSON.parse(await readFile(join(distorted, bad.reportPath), 'utf8'));
    expect(saved).toEqual(bad);
    expect(await readFile(join(correct, 'public/sprite.png'))).toEqual(await readFile(join(distorted, 'public/sprite.png')));
  }, 40_000);

  it('rejects a static noninteractive game and blocks another local port and an escaping symlink', async () => {
    let externalHits = 0;
    const external = createServer((_request, response) => {
      externalHits += 1;
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.end('private');
    });
    await new Promise<void>((resolve) => external.listen(0, '127.0.0.1', resolve));
    try {
      const address = external.address();
      if (!address || typeof address === 'string') throw new Error('port unavailable');
      const root = await createGame(`
        <canvas width="480" height="300"></canvas><p id="network"></p><p id="file"></p><p>得分 10</p><p hidden>5</p>
        <script>
          const c = document.querySelector('canvas').getContext('2d');
          c.fillStyle = '#278397'; c.fillRect(0, 0, 480, 300);
          c.fillStyle = '#ffffff'; c.fillRect(50, 50, 70, 70);
          c.fillStyle = '#db5870'; c.fillRect(170, 90, 70, 70);
          fetch('http://127.0.0.1:${address.port}/private').catch(() => {
            document.querySelector('#network').textContent = '外部请求被阻止';
          });
          const leak = new Image();
          leak.onerror = () => { document.querySelector('#file').textContent = '越界文件被阻止'; };
          leak.src = '/leak.png';
        </script>`);
      const outside = join(root, 'secret.png');
      await writeFile(outside, await readFile(join(root, 'public', 'sprite.png')));
      await symlink(outside, join(root, 'public', 'leak.png'));
      const base = createManifest();
      const manifest: GameplayPlaytestManifest = { ...base, success: [
        ...base.success,
        { kind: 'text-visible', description: '外部资源被阻止', value: '外部请求被阻止' },
        { kind: 'text-visible', description: '文件越界被阻止', value: '越界文件被阻止' },
        { kind: 'text-visible', description: '精确得分断言', value: '5' },
      ] };
      await writeFile(join(root, '.ludoready', 'playtest.json'), JSON.stringify(manifest));
      const report = await runWebPlaytest(root);
      expect(externalHits).toBe(0);
      expect(report.verdict).toBe('repair');
      expect(report.checks.find((check) => check.id === 'input-response')?.status).toBe('repair');
      expect(report.checks.find((check) => check.id === 'continuous-render')?.status).toBe('repair');
      expect(report.observations.filter((item) => item.stepId === 'success').map((item) => item.status)).toEqual(['pass', 'pass', 'pass', 'repair']);
      const score = report.observations.find((item) => item.description === '精确得分断言')!;
      expect(score.message).toContain('没有检测到可见文字“5”');
      expect(score.message).toContain('当前可见文字：');
      expect(score.message).toContain('得分 10');
    } finally {
      external.closeAllConnections();
      await new Promise<void>((resolve) => external.close(() => resolve()));
    }
  }, 30_000);
});

async function createGame(html: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ludoready-web-playtest-'));
  roots.push(root);
  await mkdir(join(root, 'public'));
  await mkdir(join(root, '.ludoready'));
  const code = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const body = html.replace(/<script>[\s\S]*?<\/script>/, '<script src="./game.js"></script>');
  await writeFile(join(root, 'public', 'game.js'), code);
  const sprite = new PNG({ width: 32, height: 32 });
  for (let i = 0; i < sprite.data.length; i += 4) {
    sprite.data[i] = 41; sprite.data[i + 1] = 183; sprite.data[i + 2] = 137; sprite.data[i + 3] = 255;
  }
  await writeFile(join(root, 'public', 'sprite.png'), PNG.sync.write(sprite));
  await writeFile(join(root, 'public', 'index.html'), `<html><head><link rel="icon" href="data:,"><style>body{margin:0}canvas{display:block}</style></head><body>${body}</body></html>`);
  await writeFile(join(root, '.ludoready', 'playtest.json'), JSON.stringify(createManifest()));
  return root;
}

function createManifest(): GameplayPlaytestManifest {
  const key = (code: string, holdMs = 0) => ({ type: 'key' as const, code, holdMs });
  const steps: Array<[string, GameplayJourneyAction]> = [
    ['ready', 'launch'], ['start-game', 'start'], ['move-player', 'move'], ['use-action', 'primary'],
    ['pause-game', 'pause'], ['resume-game', 'pause'], ['restart-game', 'restart'],
  ];
  return {
    schemaVersion: 1, updatedAt: new Date().toISOString(), engine: 'web',
    entrypoint: { path: 'public/index.html', readyTimeoutMs: 2_000 },
    actions: {
      start: { inputs: [key('Enter')] }, move: { inputs: [key('KeyD', 600)] },
      primary: { inputs: [key('Space', 600)] }, pause: { inputs: [key('Escape')] },
      restart: { inputs: [key('KeyR')] },
    },
    journey: steps.map(([id, action], index) => ({
      id, action, inputs: [], capture: `${id}.png`,
      observe: index === 0
        ? [{ kind: 'canvas-not-blank', description: '画面可见' }]
        : action === 'pause' && id === 'pause-game'
          ? [{ kind: 'text-visible', description: '暂停提示可见', value: '暂停' }]
          : [{ kind: 'screen-change', description: `${action} 有反馈`, baselineStepId: steps[index - 1][0] }],
    })),
    success: [{ kind: 'canvas-not-blank', description: '结束时画面仍有效' }],
    limits: { maxRunMs: 20_000, stepTimeoutMs: 3_000 },
  };
}

const playableGame = `
<canvas width="480" height="300"></canvas><div id="status">按回车开始</div><p id="asset"></p>
<script>
  const canvas = document.querySelector('canvas'), c = canvas.getContext('2d');
  const sprite = new Image();
  sprite.onload = () => { document.querySelector('#asset').textContent = '素材已载入'; };
  sprite.src = './sprite.png';
  let playing = false, paused = false, x = 80, tick = 0, special = false;
  const keys = new Set();
  window.addEventListener('keydown', e => {
    e.preventDefault(); keys.add(e.code);
    if(e.code === 'Enter') playing = true;
    if(e.code === 'Space') special = true;
    if(e.code === 'Escape' && !e.repeat) paused = !paused;
    if(e.code === 'KeyR') { x = 80; tick = 0; special = false; playing = false; paused = false; }
    document.querySelector('#status').textContent = paused ? '暂停' : playing ? '收集星星' : '按回车开始';
  });
  window.addEventListener('keyup', e => keys.delete(e.code));
  function draw() {
    if(playing && !paused) { tick += 2; if(keys.has('KeyD')) x = Math.min(360, x + 3); }
    c.fillStyle = playing ? '#dfedf4' : '#2c4b78'; c.fillRect(0,0,480,300);
    c.fillStyle = '#cf436c'; c.fillRect(x,200,60,60);
    if(sprite.complete && sprite.naturalWidth) c.drawImage(sprite,400,20,40,40);
    if(playing) {
      c.fillStyle = '#d9a61c'; c.fillRect(180 + Math.sin(tick / 40) * 110, 60,60,60);
      if(special) { c.fillStyle = '#137e84'; c.fillRect((tick * 2) % 400,140,70,40); }
    }
    requestAnimationFrame(draw);
  }
  draw();
</script>`;

function imageRatioGame(distorted: boolean): string {
  const croppedWidth = distorted ? 150 : 60;
  const fullHeight = distorted ? 30 : 60;
  const scaleY = distorted ? 1 : 2;
  return playableGame.replace('c.drawImage(sprite,400,20,40,40)', `{
    c.save(); c.translate(400,20); c.scale(-1,1);
    c.drawImage(sprite,0,0,sprite.naturalWidth/2,sprite.naturalHeight,0,0,${croppedWidth},120);
    c.restore();
    c.drawImage(sprite,280,20,60,${fullHeight});
    c.save(); c.translate(350,180); c.scale(2,${scaleY});
    c.drawImage(sprite,0,0,40,40); c.restore();
    // Three-argument natural-size drawing is deliberately outside the viewport.
    c.drawImage(sprite,600,0);
  }`);
}
