// --- Configuration & State ---
const CONFIG = {
  fps: 60,
  gameDuration: 20,
  scrollSpeed: 300,
  playerX: 150,
  playerYBase: 400,
  gravity: 2500,
  jumpForce: -900,
  moveRange: 100,
  hitboxW: 40,
  hitboxH: 60,
  // Visual sizes (separate from hitboxes)
  visualSizePenguin: 80,
  visualSizeFish: 40,
  visualSizeIce: 60, // Ice block visual size
  colors: {
    bg: '#87CEEB',
    ui: '#FFFFFF'
  }
};

// Fixed Obstacle Sequence (Time in seconds, Type: 'ice' or 'fish')
// First fish is on ground route to ensure collection without jump.
const SEQUENCE = [
  { t: 1.5, type: 'fish', yOff: 0 }, // Ground fish
  { t: 3.0, type: 'ice' },           // Jump obstacle
  { t: 5.0, type: 'fish', yOff: -80 }, // High fish
  { t: 7.5, type: 'ice' },
  { t: 10.0, type: 'fish', yOff: 0 },
  { t: 12.5, type: 'ice' },
  { t: 15.0, type: 'fish', yOff: -60 },
  { t: 17.5, type: 'ice' }
];

let state = 'loading'; // loading, start, playing, paused, gameover, win
let score = 0;
let health = 3;
let gameTime = 0;
let entities = [];
let particles = [];
let lastTime = 0;
let assetsLoaded = false;
let spawnIndex = 0;

const keys = {
  ArrowLeft: false,
  ArrowRight: false,
  Space: false
};

// DOM Elements
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const uiTitle = document.getElementById('game-title');
const hudScore = document.getElementById('score-display');
const hudHealth = document.getElementById('health-display');
const hudTime = document.getElementById('time-display');
const msgBox = document.getElementById('message-box');
const msgText = document.getElementById('message-text');
const btnAction = document.getElementById('btn-action');

let W = 800, H = 450; // Adjusted Canvas Height to match BG aspect ratio roughly

function resize() {
  const wrap = document.getElementById('canvas-wrap');
  const aspect = 800/450; // 16:9
  let w = wrap.clientWidth;
  let h = wrap.clientHeight;
  if (w / h > aspect) {
    w = h * aspect;
  } else {
    h = w / aspect;
  }
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
}
window.addEventListener('resize', resize);
resize();

// Asset Loading
const images = {
  penguin: [null, null],
  ice: null,
  fish: null,
  bg: null
};

function loadImages() {
  return new Promise((resolve) => {
    let loadedCount = 0;
    const total = 5;
    
    function check() {
      loadedCount++;
      if (loadedCount >= total) {
        assetsLoaded = true;
        resolve();
      }
    }

    ['penguin-player-0.png', 'penguin-player-1.png'].forEach((file, i) => {
      const img = new Image();
      img.src = `./assets/images/${file}`;
      img.onload = () => { images.penguin[i] = img; check(); };
      img.onerror = () => { console.error('Failed to load', file); check(); };
    });

    const imgIce = new Image();
    imgIce.src = './assets/images/ice-block-obstacle-0.png';
    imgIce.onload = () => { images.ice = imgIce; check(); };
    imgIce.onerror = () => { console.error('Failed to load ice'); check(); };

    const imgFish = new Image();
    imgFish.src = './assets/images/fish-collectible-0.png';
    imgFish.onload = () => { images.fish = imgFish; check(); };
    imgFish.onerror = () => { console.error('Failed to load fish'); check(); };

    const imgBg = new Image();
    imgBg.src = './assets/images/background-e8322dd33de2-c889663d-693f-4f88-ab51-761d43d6bcb7.png';
    imgBg.onload = () => { images.bg = imgBg; check(); };
    imgBg.onerror = () => { console.error('Failed to load bg'); check(); };
  });
}

// Game Objects
const player = {
  x: CONFIG.playerX,
  y: CONFIG.playerYBase,
  vy: 0,
  isJumping: false,
  frameIndex: 0,
  frameTimer: 0,
  invincibleTimer: 0
};

function updateUI() {
  hudScore.textContent = `得分: ${score}`;
  hudHealth.textContent = `生命: ${'❤️'.repeat(health)}`;
  hudTime.textContent = `时间: ${(CONFIG.gameDuration - gameTime).toFixed(1)}s`;
}

function showMessage(text, buttonText) {
  msgText.textContent = text;
  btnAction.textContent = buttonText;
  msgBox.classList.remove('hidden');
}

function hideMessage() {
  msgBox.classList.add('hidden');
}

function resetGame() {
  state = 'playing';
  score = 0;
  health = 3;
  gameTime = 0;
  entities = [];
  particles = [];
  spawnIndex = 0;
  player.x = CONFIG.playerX;
  player.y = CONFIG.playerYBase;
  player.vy = 0;
  player.isJumping = false;
  player.invincibleTimer = 0;
  hideMessage();
  updateUI();
}

function spawnEntity(seqItem) {
  const e = {
    type: seqItem.type,
    x: W + 50,
    y: seqItem.type === 'ice' ? CONFIG.playerYBase : CONFIG.playerYBase + (seqItem.yOff || 0),
    // Hitbox dimensions for collision logic
    w: seqItem.type === 'ice' ? 50 : 30, 
    h: seqItem.type === 'ice' ? 50 : 20,
    collected: false
  };
  entities.push(e);
}

function createParticles(x, y, color) {
  for(let i=0; i<5; i++) {
    particles.push({
      x: x, y: y,
      vx: (Math.random()-0.5)*200,
      vy: (Math.random()-0.5)*200 - 100,
      life: 1.0,
      color: color
    });
  }
}

// Update Logic
function update(dt) {
  if (state !== 'playing') return;

  gameTime += dt;
  updateUI();
  
  if (gameTime >= CONFIG.gameDuration) {
    state = 'win';
    showMessage(`挑战成功! 最终得分: ${score}`, '重新开始');
    return;
  }

  while(spawnIndex < SEQUENCE.length && gameTime >= SEQUENCE[spawnIndex].t) {
    spawnEntity(SEQUENCE[spawnIndex]);
    spawnIndex++;
  }

  let moveDir = 0;
  if (keys.ArrowLeft) moveDir -= 1;
  if (keys.ArrowRight) moveDir += 1;
  
  player.x += moveDir * 100 * dt;
  if (player.x < CONFIG.playerX - CONFIG.moveRange) player.x = CONFIG.playerX - CONFIG.moveRange;
  if (player.x > CONFIG.playerX + CONFIG.moveRange) player.x = CONFIG.playerX + CONFIG.moveRange;
  if (moveDir === 0) {
    player.x += (CONFIG.playerX - player.x) * 5 * dt;
  }

  if (player.isJumping) {
    player.vy += CONFIG.gravity * dt;
    player.y += player.vy * dt;
    
    if (player.y >= CONFIG.playerYBase) {
      player.y = CONFIG.playerYBase;
      player.isJumping = false;
      player.vy = 0;
    }
  }

  if (!player.isJumping) {
    player.frameTimer += dt;
    if (player.frameTimer > 0.15) {
      player.frameIndex = (player.frameIndex + 1) % 2;
      player.frameTimer = 0;
    }
  } else {
    player.frameIndex = 0;
  }

  if (player.invincibleTimer > 0) {
    player.invincibleTimer -= dt;
  }

  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i];
    e.x -= CONFIG.scrollSpeed * dt;
    
    if (!e.collected) {
      // Correct Collision Box Calculation using Hitbox Config
      const px = player.x - CONFIG.hitboxW/2;
      const py = player.y - CONFIG.hitboxH;
      const pw = CONFIG.hitboxW;
      const ph = CONFIG.hitboxH;
      
      const ex = e.x - e.w/2;
      const ey = e.y - e.h;
      const ew = e.w;
      const eh = e.h;
      
      if (px < ex + ew && px + pw > ex && py < ey + eh && py + ph > ey) {
        if (e.type === 'ice') {
          if (player.invincibleTimer <= 0) {
            health--;
            player.invincibleTimer = 1.0;
            createParticles(player.x, player.y - 30, '#FF4444');
            updateUI();
            if (health <= 0) {
              state = 'gameover';
              showMessage(`游戏结束! 最终得分: ${score}`, '重新开始');
            }
          }
        } else if (e.type === 'fish') {
          score += 10;
          e.collected = true;
          createParticles(e.x, e.y - 15, '#FFC107');
          updateUI();
        }
      }
    }

    if (e.x < -100) {
      entities.splice(i, 1);
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 500 * dt;
    p.life -= dt;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

// Render Logic
function draw() {
  ctx.fillStyle = '#E0F7FA';
  ctx.fillRect(0, 0, W, H);

  if (images.bg) {
    // Draw Background maintaining aspect ratio (Cover/Fit strategy)
    // Source 1024x576, Target 800x450 -> Aspect matches perfectly
    ctx.drawImage(images.bg, 0, 0, W, H);
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.moveTo(0, CONFIG.playerYBase);
  ctx.lineTo(W, CONFIG.playerYBase);
  ctx.stroke();

  entities.forEach(e => {
    if (e.collected) return;
    let img = e.type === 'ice' ? images.ice : images.fish;
    let vSize = e.type === 'ice' ? CONFIG.visualSizeIce : CONFIG.visualSizeFish;
    
    if (img) {
      // Draw square proportional to source
      ctx.drawImage(img, e.x - vSize/2, e.y - vSize, vSize, vSize);
    } else {
      ctx.fillStyle = e.type === 'ice' ? '#4DD0E1' : '#FF9800';
      ctx.fillRect(e.x - vSize/2, e.y - vSize, vSize, vSize);
    }
  });

  if (state === 'playing' || state === 'paused' || state === 'start') {
    const img = images.penguin[player.frameIndex];
    if (img) {
      if (player.invincibleTimer > 0 && Math.floor(gameTime * 10) % 2 === 0) {
        ctx.globalAlpha = 0.5;
      }
      // Draw Penguin 80x80 centered on X, aligned to Bottom Y
      const vSize = CONFIG.visualSizePenguin;
      ctx.drawImage(img, player.x - vSize/2, player.y - vSize, vSize, vSize);
      ctx.globalAlpha = 1.0;
    } else {
      ctx.fillStyle = '#37474F';
      ctx.fillRect(player.x - 20, player.y - 40, 40, 40);
    }
  }

  particles.forEach(p => {
    ctx.fillStyle = p.color;
    ctx.globalAlpha = p.life;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI*2);
    ctx.fill();
  });
  ctx.globalAlpha = 1.0;
}

// Main Loop
function loop(timestamp) {
  if (!lastTime) lastTime = timestamp;
  const dt = (timestamp - lastTime) / 1000;
  lastTime = timestamp;
  const cappedDt = Math.min(dt, 0.1);

  update(cappedDt);
  draw();

  requestAnimationFrame(loop);
}

// Input Handlers
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (state === 'start') {
      resetGame();
    } else if (state === 'playing' && !player.isJumping) {
      player.isJumping = true;
      player.vy = CONFIG.jumpForce;
    }
  }
  if (e.code === 'KeyP') {
    if (state === 'playing') {
      state = 'paused';
      showMessage('暂停中', '继续游戏');
    }
    else if (state === 'paused') {
      state = 'playing';
      hideMessage();
    }
  }
  if (e.code === 'KeyR') {
    if (state === 'gameover' || state === 'win') {
      state = 'start';
      showMessage('按空格键开始', '开始游戏');
    }
  }
  if (e.code === 'ArrowLeft') keys.ArrowLeft = true;
  if (e.code === 'ArrowRight') keys.ArrowRight = true;
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowLeft') keys.ArrowLeft = false;
  if (e.code === 'ArrowRight') keys.ArrowRight = false;
});

// Touch Controls
const btnLeft = document.getElementById('btn-left');
const btnRight = document.getElementById('btn-right');
const btnJump = document.getElementById('btn-jump');
const btnPause = document.getElementById('btn-pause');

function setupTouchBtn(btn, keyName, actionFn) {
  btn.addEventListener('pointerdown', (e) => { 
    e.preventDefault(); 
    btn.setPointerCapture(e.pointerId);
    if(keyName) keys[keyName]=true; 
    if(actionFn) actionFn(); 
  });
  btn.addEventListener('pointerup', (e) => { 
    e.preventDefault(); 
    if(keyName) keys[keyName]=false; 
  });
  btn.addEventListener('pointercancel', (e) => { 
    e.preventDefault(); 
    if(keyName) keys[keyName]=false; 
  });
}

setupTouchBtn(btnLeft, 'ArrowLeft');
setupTouchBtn(btnRight, 'ArrowRight');
setupTouchBtn(btnJump, null, () => {
  if (state === 'start') { resetGame(); }
  else if (state === 'playing' && !player.isJumping) {
    player.isJumping = true;
    player.vy = CONFIG.jumpForce;
  }
});

btnPause.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (state === 'playing') {
    state = 'paused';
    showMessage('暂停中', '继续游戏');
  } else if (state === 'paused') {
    state = 'playing';
    hideMessage();
  }
});

btnAction.addEventListener('click', () => {
  if (state === 'start' || state === 'gameover' || state === 'win') {
    resetGame();
  } else if (state === 'paused') {
    state = 'playing';
    hideMessage();
  }
});

canvas.addEventListener('click', () => {
  if (state === 'start') {
    resetGame();
  }
});

// Init
loadImages().then(() => {
  state = 'start';
  showMessage('按空格键开始', '开始游戏');
  requestAnimationFrame(loop);
});