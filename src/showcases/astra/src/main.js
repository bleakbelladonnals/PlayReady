import './style.css';
import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWorld } from './world.js';

const stage = document.querySelector('#stage');
const status = document.querySelector('#status');
let renderer;
try {
  renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
} catch (error) {
  document.querySelector('#error').hidden = false;
  throw error;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
stage.append(renderer.domElement);

const scene = new T.Scene();
const camera = new T.PerspectiveCamera(35, 1, .1, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
controls.dampingFactor = .055;
controls.minDistance = 4.2;
controls.maxDistance = 35;
controls.maxPolarAngle = Math.PI * .49;
controls.minPolarAngle = .35;
controls.enablePan = false;
controls.autoRotateSpeed = .7;
const world = createWorld(scene);

let paused = false;
let orbit = false;
let ready = false;
let pace = 1;
let paceCurrent = 1;
let time = 0;
let travel = 0;
let last = 0;
let mode = 'coast';
let light = 'sunset';
let cameraTween = null;
let cameraInitialized = false;
const announce = (text) => { status.textContent = text; };

function publishState() {
  if (ready) window.parent.postMessage({
    type: 'ludoready-showcase-state', ready: true,
    paused, muted: true,
  }, '*');
}
function homeCamera(sceneMode = mode) {
  const aspect = stage.clientWidth / Math.max(stage.clientHeight, 1);
  const fit = Math.max(1, 1.4 / aspect);
  const target = sceneMode === 'studio' ? new T.Vector3(4.9, 3.8, 8.4) : new T.Vector3(7.1, 5.1, 11.2);
  return target.multiplyScalar(fit);
}
function resize() {
  const width = stage.clientWidth;
  const height = Math.max(stage.clientHeight, 1);
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (!cameraInitialized) {
    camera.position.copy(homeCamera());
    controls.update();
    cameraInitialized = true;
  }
}
new ResizeObserver(resize).observe(stage);
resize();
function selected(ids, id) {
  for (const value of ids) {
    const button = document.getElementById(value);
    button.classList.toggle('selected', value === id);
    button.setAttribute('aria-pressed', String(value === id));
  }
}
function updateLabel() {
  document.querySelector('#scene-label').textContent = `${mode === 'coast' ? '海岸' : '摄影棚'} · ${{ day: '白天', sunset: '日落', night: '夜晚' }[light]}`;
}
for (const id of ['day', 'sunset', 'night']) document.getElementById(id).onclick = () => {
  light = id;
  world.lighting(id);
  document.body.dataset.light = id;
  selected(['day', 'sunset', 'night'], id);
  updateLabel();
  announce(`已切换为${{ day: '白天', sunset: '日落', night: '夜晚' }[id]}`);
};
for (const id of ['cruise', 'sprint']) document.getElementById(id).onclick = () => {
  pace = id === 'sprint' ? 2.1 : 1;
  selected(['cruise', 'sprint'], id);
  announce(id === 'sprint' ? '快骑' : '慢骑');
};
for (const id of ['coast', 'studio']) document.getElementById(id).onclick = () => {
  mode = id;
  world.setMode(id);
  selected(['coast', 'studio'], id);
  updateLabel();
  cameraTween = {
    from: camera.position.clone(), to: homeCamera(id),
    aimFrom: controls.target.clone(), aimTo: new T.Vector3(0, id === 'studio' ? 1.65 : 1, 0), t: 0,
  };
  announce(id === 'coast' ? '海岸场景' : '摄影棚场景');
};
document.getElementById('orbit').onclick = () => {
  orbit = !orbit;
  document.getElementById('orbit').setAttribute('aria-pressed', String(orbit));
  announce(orbit ? '已开启自动环绕' : '已关闭自动环绕');
};
function updatePause() {
  const button = document.getElementById('pause');
  const stopped = paused;
  button.setAttribute('aria-pressed', String(stopped));
  button.setAttribute('aria-label', stopped ? '继续骑行' : '暂停骑行');
  button.querySelector('span').textContent = stopped ? '继续' : '暂停';
  button.querySelector('path').setAttribute('d', stopped ? 'M4 2L13 8L4 14Z' : 'M5 3v10M11 3v10');
}
function togglePause() {
  paused = !paused;
  updatePause();
  announce(paused ? '骑行已暂停' : '继续骑行');
  publishState();
}
document.getElementById('pause').onclick = togglePause;
updatePause();
controls.addEventListener('start', () => { cameraTween = null; });

// Parent and scene controls share one playback state. Rendering stays active
// during pause so light, scene, and manual camera controls remain responsive.
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.data?.type !== 'ludoready-showcase') return;
  switch (event.data.command) {
    case 'pause':
      paused = true;
      break;
    case 'resume':
      paused = false;
      break;
    case 'mute':
    case 'unmute':
      break;
    default:
      return;
  }
  updatePause();
  publishState();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    window.parent.postMessage({ type: 'ludoready-showcase-close' }, '*');
  } else if (event.code === 'Space' && !event.target.closest('button, input, select, textarea')) {
    event.preventDefault();
    togglePause();
  }
});

// Cadence changes share one travel coordinate, so feet stay on the pedals.
function frame(ms) {
  const dt = last ? Math.min((ms - last) / 1000, .05) : 0;
  last = ms;
  paceCurrent += (pace - paceCurrent) * Math.min(dt * 4, 1);
  if (!paused) { time += dt; travel += dt * paceCurrent * .95; }
  if (cameraTween) {
    cameraTween.t = Math.min(1, cameraTween.t + dt * .8);
    const t = cameraTween.t * cameraTween.t * (3 - 2 * cameraTween.t);
    camera.position.lerpVectors(cameraTween.from, cameraTween.to, t);
    controls.target.lerpVectors(cameraTween.aimFrom, cameraTween.aimTo, t);
    if (cameraTween.t === 1) cameraTween = null;
  }
  controls.autoRotate = orbit && !paused;
  controls.update(dt);
  world.renderAt(time, travel);
  renderer.render(scene, camera);
  if (!ready) { ready = true; publishState(); }
  requestAnimationFrame(frame);
}
document.body.dataset.light = light;
frame(performance.now());
