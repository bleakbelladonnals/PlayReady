const { app, BrowserWindow, session } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

const root = resolve(__dirname, '..');
const output = join(root, '.ludoready-private/showcase-qa');
mkdirSync(output, { recursive: true });
app.setPath('userData', join(output, 'electron-profile'));
app.setPath('sessionData', join(output, 'electron-profile'));
app.on('window-all-closed', () => {});
const report = { checkedAt: new Date().toISOString(), electron: process.versions.electron, transport: 'file://', sandbox: 'allow-scripts allow-pointer-lock', ok: false, works: [] };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (image) => createHash('sha256').update(image.toBitmap()).digest('hex');
function pixelDifference(first, second) {
  const a = first.toBitmap(), b = second.toBitmap();
  let changed = 0, significant = 0, total = 0, maximum = 0;
  for (let i = 0; i < a.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 3; c++) {
      const value = Math.abs(a[i + c] - b[i + c]);
      delta = Math.max(delta, value); total += value;
    }
    if (delta) changed++;
    if (delta > 8) significant++;
    maximum = Math.max(maximum, delta);
  }
  return { changedPixelRatio: changed / (a.length / 4), significantPixelRatio: significant / (a.length / 4), maximumChannelDelta: maximum, meanChannelDelta: total / (a.length / 4 * 3) };
}

async function until(read, accepts, label, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (accepts(last)) return last;
    await sleep(100);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

function hostHtml(url) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self' file:; object-src 'none'">
  <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}nav{height:44px;display:flex;gap:8px;align-items:center;padding:0 8px;background:#edf3f3}button{width:90px;height:30px}iframe{display:block;width:100%;height:calc(100% - 44px);border:0}</style></head>
  <body><nav>${['pause', 'resume', 'unmute', 'mute'].map(command => `<button data-command="${command}">${command}</button>`).join('')}</nav>
  <script>window.observed=[];addEventListener('message',event=>{if(event.source===document.querySelector('iframe')?.contentWindow)window.observed.push(event.data)});document.querySelectorAll('button').forEach(button=>button.onclick=()=>document.querySelector('iframe').contentWindow.postMessage({type:'ludoready-showcase',command:button.dataset.command},'*'));</script>
  <iframe sandbox="allow-scripts allow-pointer-lock" allow="autoplay; fullscreen" src="${url}"></iframe></body></html>`;
}

async function inspect(id) {
  const result = { id, ok: false, consoleErrors: [], exceptions: [], externalRequests: [], loadFailures: [], checks: {} };
  report.works.push(result);
  const isolated = session.fromPartition(`showcase-smoke-${id}-${Date.now()}`, { cache: false });
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const external = /^(https?|wss?):/i.test(details.url);
    if (external) result.externalRequests.push({ url: details.url, resourceType: details.resourceType });
    callback({ cancel: external });
  });
  const window = new BrowserWindow({ width: 1120, height: 820, show: true, title: `Ludo Ready — ${id} offline QA`, webPreferences: {
    session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false,
  } });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('console-message', (event) => {
    if (event.level === 'error') result.consoleErrors.push({ message: event.message, source: event.sourceId, line: event.lineNumber });
  });
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) => result.loadFailures.push({ code, description, url, mainFrame }));
  contents.on('render-process-gone', (_event, details) => result.exceptions.push({ rendererGone: details }));
  try {
    contents.debugger.attach('1.3');
    contents.debugger.on('message', (_event, method, params) => {
      if (method === 'Runtime.exceptionThrown') result.exceptions.push(params.exceptionDetails);
    });
    const runtimeEnabled = contents.debugger.sendCommand('Runtime.enable');
    const wrapper = join(output, `native-${id}.html`);
    writeFileSync(wrapper, hostHtml(pathToFileURL(join(root, `dist/renderer/showcases/${id}/index.html`)).href));
    const began = Date.now();
    await window.loadFile(wrapper);
    await runtimeEnabled;
    const states = () => contents.executeJavaScript("window.observed.filter(item=>item?.type==='ludoready-showcase-state')");
    const initial = await until(states, values => values.some(value => value.ready), `${id} ready`);
    result.readyMs = Date.now() - began;
    result.initialState = initial.at(-1);
    result.checks.ready = result.initialState.ready === true && result.initialState.paused === false && result.initialState.muted === true;
    const child = contents.mainFrame.frames.find(frame => frame.url.includes(`/showcases/${id}/index.html`));
    if (!child) throw new Error('Loaded showcase child frame is missing');
    result.childUrl = child.url;
    result.sandboxIsolation = await child.executeJavaScript("({node:typeof require,parentBlocked:(()=>{try{void parent.document.body;return false}catch{return true}})()})");
    result.checks.isolated = result.sandboxIsolation.node === 'undefined' && result.sandboxIsolation.parentBlocked;

    async function command(name, accepts) {
      const before = (await states()).length;
      const point = await contents.executeJavaScript(`(()=>{const r=document.querySelector('[data-command="${name}"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      return (await until(states, values => values.length > before && accepts(values.at(-1)), `${id} ${name}`)).at(-1);
    }

    const capture = () => contents.capturePage({ x: 250, y: 210, width: 580, height: 400 });
    await sleep(900);
    const activeA = await capture();
    await sleep(400);
    const activeB = await capture();
    result.checks.initialMotion = hash(activeA) !== hash(activeB);
    writeFileSync(join(output, `${id}-native-running.png`), (await contents.capturePage()).toPNG());
    await command('pause', value => value.paused === true);
    await sleep(1800);
    const pausedA = await capture();
    await sleep(500);
    const pausedB = await capture();
    result.checks.pauseState = true;
    result.pauseHashes = [hash(pausedA), hash(pausedB)];
    result.pausedPixelDifference = pixelDifference(pausedA, pausedB);
    // Astra keeps its original light interpolation while paused. Permit only
    // sparse, two-level color convergence, never visible movement.
    result.pauseTolerance = { maximumChannelDelta: 2, maximumChangedPixelRatio: 0.005 };
    result.checks.pausedImageStable = result.pausedPixelDifference.maximumChannelDelta <= 2
      && result.pausedPixelDifference.changedPixelRatio <= 0.005;
    writeFileSync(join(output, `${id}-native-pause-a.png`), pausedA.toPNG());
    writeFileSync(join(output, `${id}-native-pause-b.png`), pausedB.toPNG());
    writeFileSync(join(output, `${id}-native-paused.png`), (await contents.capturePage()).toPNG());
    await command('resume', value => value.paused === false);
    await sleep(300);
    const resumedA = await capture();
    await sleep(500);
    const resumedB = await capture();
    result.checks.resumeState = true;
    result.checks.resumedImageChanges = hash(resumedA) !== hash(resumedB);

    if (id === 'opus') {
      // Observe native context state without changing playback or autoplay policy.
      await child.executeJavaScript(`window.qaAudioContexts=[];window.AudioContext=new Proxy(window.AudioContext,{construct(target,args){const context=Reflect.construct(target,args);window.qaAudioContexts.push(context);return context}})`);
      const audioStates = () => child.executeJavaScript('window.qaAudioContexts.map(context=>context.state)');
      await command('unmute', value => value.muted === false);
      result.audioUnmuted = await until(audioStates, values => values.includes('running'), 'opus AudioContext running', 5000);
      result.checks.unmuteStateAndAudioRunning = true;
      await command('pause', value => value.paused === true);
      result.audioPaused = await until(audioStates, values => values.length > 0 && values.every(value => value === 'suspended'), 'opus paused AudioContext');
      result.checks.pauseSuspendsAudio = true;
      await command('resume', value => value.paused === false);
      await until(audioStates, values => values.includes('running'), 'opus resumed AudioContext');
      result.checks.resumeRestartsAudio = true;
      await command('mute', value => value.muted === true);
      result.audioMuted = await until(audioStates, values => values.length > 0 && values.every(value => value === 'suspended'), 'opus muted AudioContext');
      result.checks.muteStateAndAudioSuspended = true;
    }
    result.states = await states();
    result.checks.noExternalRequests = result.externalRequests.length === 0;
    result.checks.noJsExceptions = result.exceptions.length === 0;
    result.checks.noConsoleErrors = result.consoleErrors.length === 0;
    result.checks.noLoadFailures = result.loadFailures.length === 0;
  } catch (error) {
    result.error = error.stack ?? String(error);
  } finally {
    if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
    window.destroy();
    result.checks.destroyed = window.isDestroyed();
    result.ok = !result.error && Object.values(result.checks).every(Boolean);
    process.stdout.write(`${id}: ${result.ok ? 'PASS' : 'FAIL'} ${JSON.stringify(result.checks)}${result.error ? ` ${result.error.split('\n')[0]}` : ''}\n`);
  }
}

app.whenReady().then(async () => {
  try {
    for (const id of ['astra', 'opus']) await inspect(id);
    report.ok = report.works.every(work => work.ok);
  } catch (error) { report.error = error.stack ?? String(error); }
  finally {
    writeFileSync(join(output, 'native-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    app.exit(report.ok ? 0 : 1);
  }
});
