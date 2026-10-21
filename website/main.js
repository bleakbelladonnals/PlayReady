const dialog = document.querySelector('#play-dialog');
const frameWrap = document.querySelector('#play-frame-wrap');
let currentGame;
let returnFocus;

function openGame(game, trigger) {
  currentGame = game;
  returnFocus = trigger;
  dialog.dataset.game = game.id;
  document.querySelector('#play-title').textContent = game.title;
  document.querySelector('#play-controls').textContent = game.controls;
  document.querySelector('#play-description').textContent = game.description;
  const frame = document.createElement('iframe');
  frame.title = `${game.title} 游戏试玩`;
  frame.src = game.path;
  frame.allow = 'fullscreen';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock');
  frame.addEventListener('load', () => frame.focus(), { once: true });
  frameWrap.replaceChildren(frame);
  dialog.showModal();
  document.body.classList.add('playing');
}

function closeGame() { dialog.close(); }
dialog.querySelector('.close-dialog').addEventListener('click', closeGame);
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeGame();
  }
});
dialog.addEventListener('close', () => {
  frameWrap.replaceChildren();
  document.body.classList.remove('playing');
  returnFocus?.focus();
});
document.querySelector('#restart-game').addEventListener('click', () => {
  const frame = frameWrap.querySelector('iframe');
  if (frame && currentGame) frame.src = currentGame.path;
});

async function loadGames() {
  const response = await fetch('/games/catalog.json');
  if (!response.ok) throw new Error('作品暂时未能加载，请刷新重试。');
  const games = await response.json();
  const featured = games[0];
  document.querySelector('#featured-title').textContent = featured.title;
  document.querySelector('#featured-name').textContent = featured.title;
  const featuredCover = document.querySelector('#featured-cover');
  featuredCover.src = featured.cover;
  featuredCover.alt = `${featured.title} 的真实游戏画面`;
  for (const id of ['hero-play', 'featured-play']) {
    const trigger = document.getElementById(id);
    trigger.setAttribute('aria-label', `试玩${featured.title}`);
    trigger.addEventListener('click', () => openGame(featured, trigger));
  }
  const grid = document.querySelector('#games-grid');
  for (const [index, game] of games.entries()) {
    const card = document.createElement('article');
    card.className = 'game-card';
    const button = document.createElement('button');
    button.className = 'game-cover-button';
    button.type = 'button';
    button.setAttribute('aria-label', `试玩${game.title}`);
    const img = document.createElement('img');
    img.src = game.cover;
    img.alt = `${game.title} 游戏画面`;
    img.loading = 'lazy';
    img.width = 960;
    img.height = 640;
    const overlay = document.createElement('span');
    overlay.className = 'game-hover-label';
    overlay.textContent = '进入游戏 ↗';
    button.append(img, overlay);
    button.addEventListener('click', () => openGame(game, button));
    const meta = document.createElement('div');
    meta.className = 'game-meta';
    const number = document.createElement('span');
    number.textContent = `${String(index + 1).padStart(2, '0')} / ${game.genre}`;
    const format = document.createElement('span');
    format.textContent = '浏览器即玩';
    meta.append(number, format);
    const heading = document.createElement('h3');
    heading.textContent = game.title;
    const description = document.createElement('p');
    description.textContent = game.description;
    const play = document.createElement('button');
    play.className = 'text-link card-play';
    play.type = 'button';
    play.textContent = '玩一局 ↗';
    play.setAttribute('aria-label', `开始试玩${game.title}`);
    play.addEventListener('click', () => openGame(game, play));
    card.append(button, meta, heading, description, play);
    grid.append(card);
  }
}

loadGames().catch((error) => {
  document.querySelector('#games-grid').textContent = error.message;
  document.querySelector('#hero-play').hidden = true;
  document.querySelector('#hero-stage').hidden = true;
});
