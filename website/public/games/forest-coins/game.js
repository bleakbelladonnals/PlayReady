(function(){
'use strict';
var canvas=document.getElementById('game');
var ctx=canvas.getContext('2d');
var scoreEl=document.getElementById('score');
var missEl=document.getElementById('miss');
var missBox=document.getElementById('missBox');
var overlay=document.getElementById('overlay');
var titleEl=document.getElementById('title');
var subtitleEl=document.getElementById('subtitle');
var finalScore=document.getElementById('finalScore');
var finalScoreVal=document.getElementById('finalScoreVal');
var primaryBtn=document.getElementById('primaryBtn');
var pauseBtn=document.getElementById('pauseBtn');
var leftBtn=document.getElementById('leftBtn');
var rightBtn=document.getElementById('rightBtn');

var W=720,H=1080;
var STATE={READY:0,PLAY:1,PAUSE:2,OVER:3};
var state=STATE.READY;

// Define atlas regions for fox and coin to crop single poses correctly
var ASSETS={
  background:{src:'./assets/images/background-271ddb2edd83-cfa6f50f-9867-4c84-9770-fd89e8754f28.png'},
  fox:{frames:['./assets/images/fox-0.png','./assets/images/fox-1.png'],frameMs:180},
  coin:{frames:['./assets/images/coin-0.png','./assets/images/coin-1.png'],frameMs:180}
};
var img={background:null,fox:[],coin:[]};
var loaded=0,total=0;

function loadImages(){
  img.background=new Image();
  img.background.onload=onImg;img.background.onerror=onImg;
  img.background.src=ASSETS.background.src;total++;
  ['fox','coin'].forEach(function(k){
    img[k]=[];
    ASSETS[k].frames.forEach(function(p,i){
      var im=new Image();
      im.onload=onImg;im.onerror=onImg;
      im.src=p;img[k].push(im);total++;
    });
  });
}
function onImg(){loaded++;if(loaded>=total){document.body.classList.add('assets-ready');}}

var fox={x:W/2,y:H-160,w:150,h:150,speed:520,face:1,anim:0};
var coins=[];
var floaters=[];
var score=0,miss=0;
var spawnTimer=0,spawnInterval=1.0;
var fallBase=220,fallSpeed=220;
var warnFlash=0;
var lastTime=0,paused=false;
var firstCoinSpawned = false;
var nextCoinSide = 'left'; // Alternating sides after the first center one

function resetGame(){
  coins.length=0;floaters.length=0;
  score=0;miss=0;spawnTimer=0;spawnInterval=1.0;fallSpeed=fallBase;
  fox.x=W/2;fox.face=1;fox.anim=0;
  warnFlash=0;
  firstCoinSpawned = false;
  nextCoinSide = 'left';
  updateHud();
}

function updateHud(){
  scoreEl.textContent=String(score);
  missEl.textContent=String(miss);
  if(miss>=2){missBox.classList.add('warn');}else{missBox.classList.remove('warn');}
}

function spawnCoin(){
  var s=70;
  var x;
  if (!firstCoinSpawned) {
    x = W / 2 - s / 2; // Center drop for first coin
    firstCoinSpawned = true;
  } else {
    if (nextCoinSide === 'left') {
      x = s / 2 + Math.random() * (W / 2 - s); // Left half
      nextCoinSide = 'right';
    } else {
      x = W / 2 + Math.random() * (W / 2 - s); // Right half
      nextCoinSide = 'left';
    }
  }
  coins.push({x:x+s/2,y:100,w:s,h:s,vy:fallSpeed,anim:0});
}

function addFloater(x,y,txt,color){
  floaters.push({x:x,y:y,txt:txt,color:color,life:0.9});
}

function rectHit(a,b){
  return a.x-a.w/2<b.x+b.w/2 && a.x+a.w/2>b.x-b.w/2 &&
         a.y-a.h/2<b.y+b.h/2 && a.y+a.h/2>b.y-b.w/2;
}

var keys={left:false,right:false};

function update(dt){
  if(state!==STATE.PLAY)return;
  var mv=0;
  if(keys.left)mv-=1;
  if(keys.right)mv+=1;
  if(mv!==0){fox.face=mv;fox.anim+=dt;}
  else{fox.anim=0;}
  fox.x+=mv*fox.speed*dt;
  if(fox.x<fox.w/2)fox.x=fox.w/2;
  if(fox.x>W-fox.w/2)fox.x=W-fox.w/2;

  spawnTimer+=dt;
  if(spawnTimer>=spawnInterval){spawnTimer=0;spawnCoin();
    if(spawnInterval>0.55)spawnInterval*=0.985;
    if(fallSpeed<560)fallSpeed+=6;
  }

  for(var i=coins.length-1;i>=0;i--){
    var c=coins[i];
    c.y+=c.vy*dt;c.anim+=dt;
    var hit={x:fox.x,y:fox.y,w:fox.w,h:fox.h};
    if(rectHit(hit,c)){
      coins.splice(i,1);
      score+=5;addFloater(c.x,c.y,'+5','#f5c842');
      updateHud();continue;
    }
    if(c.y-c.h/2>H){
      coins.splice(i,1);
      miss++;warnFlash=0.5;addFloater(c.x,H-30,'漏接!','#ff6b35');
      updateHud();
      if(miss>=3){gameOver();return;}
    }
  }

  for(var j=floaters.length-1;j>=0;j--){
    var f=floaters[j];f.life-=dt;f.y-=60*dt;
    if(f.life<=0)floaters.splice(j,1);
  }

  if(warnFlash>0)warnFlash-=dt;
}

function drawCover(){
  var iw=img.background.naturalWidth||1024,ih=img.background.naturalHeight||1536;
  var scale=Math.max(W/iw,H/ih);
  var dw=iw*scale,dh=ih*scale;
  var dx=(W-dw)/2,dy=(H-dh)/2;
  ctx.drawImage(img.background,dx,dy,dw,dh);
}

function frameFor(anim,frames,frameMs){
  if(frames.length<=1)return frames[0];
  var idx=Math.floor((anim*1000)/frameMs)%frames.length;
  return frames[idx];
}

function drawFox(){
  var frames=img.fox;
  var moving=(keys.left||keys.right);
  var fr;
  if(moving){
    // Use the second image which has run pose in left half
    fr=frames[1]; 
  }else{
    // Use first image idle pose in left half
    fr=frames[0];
  }
  ctx.save();
  ctx.translate(fox.x,fox.y);
  if(fox.face<0)ctx.scale(-1,1);
  if(fr&&fr.naturalWidth){
    // Crop only the left square region of the image to show one pose (0,140,256,256)
    ctx.drawImage(fr, 0, 140, 256, 256, -fox.w/2, -fox.h/2, fox.w, fox.h);
  }
  ctx.restore();
}

function drawCoin(c){
  var fr=frameFor(c.anim,img.coin,ASSETS.coin.frameMs);
  ctx.save();
  ctx.translate(c.x,c.y);
  if(fr&&fr.naturalWidth){
    // Crop only the left square region of the image to show one pose (0,140,256,256)
    ctx.drawImage(fr, 0, 140, 256, 256, -c.w/2, -c.h/2, c.w, c.h);
  }
  ctx.restore();
}

function drawFloaters(){
  ctx.textAlign='center';ctx.font='bold 40px "Segoe UI",sans-serif';
  for(var i=0;i<floaters.length;i++){
    var f=floaters[i];
    ctx.globalAlpha=Math.max(0,Math.min(1,f.life));
    ctx.fillStyle=f.color;
    ctx.strokeStyle='#1e5c2e';ctx.lineWidth=4;
    ctx.strokeText(f.txt,f.x,f.y);
    ctx.fillText(f.txt,f.x,f.y);
  }
  ctx.globalAlpha=1;
}

function render(){
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,W,H);
  if(img.background&&img.background.naturalWidth){drawCover();}
  else{ctx.fillStyle='#2d7a3f';ctx.fillRect(0,0,W,H);}
  for(var i=0;i<coins.length;i++){drawCoin(coins[i]);}
  drawFox();
  drawFloaters();
  if(warnFlash>0){
    ctx.fillStyle='rgba(255,60,40,'+(warnFlash*0.5)+')';
    ctx.fillRect(0,0,W,H);
  }
}

function loop(ts){
  if(!lastTime)lastTime=ts;
  var dt=(ts-lastTime)/1000;lastTime=ts;
  if(dt>0.05)dt=0.05;
  if(state===STATE.PLAY){update(dt);}
  render();
  requestAnimationFrame(loop);
}

function showOverlay(t,sub,primaryText,showFinal){
  titleEl.textContent=t;
  subtitleEl.innerHTML=sub;
  primaryBtn.textContent=primaryText;
  if(showFinal){finalScoreVal.textContent=String(score);finalScore.classList.remove('hidden');}
  else{finalScore.classList.add('hidden');}
  overlay.classList.remove('hidden');
}
function hideOverlay(){overlay.classList.add('hidden');}

function startGame(){
  resetGame();state=STATE.PLAY;paused=false;
  hideOverlay();pauseBtn.textContent='暂停';
  lastTime = 0; // Reset lastTime to ensure smooth resume
  spawnCoin(); // Spawn the very first coin immediately at center y=100
}
function gameOver(){
  state=STATE.OVER;
  showOverlay('游戏结束','漏接三次，小狐狸没接住金币啦。','重新开始',true);
}
function togglePause(){
  if(state===STATE.PLAY){state=STATE.PAUSE;paused=true;
    showOverlay('已暂停','休息一下，点击继续游戏。','继续',false);
    pauseBtn.textContent='继续';
  }else if(state===STATE.PAUSE){state=STATE.PLAY;paused=false;
    hideOverlay();pauseBtn.textContent='暂停';
    lastTime = 0; // Reset lastTime to prevent large dt jump
  }
}

primaryBtn.addEventListener('click',function(){
  if(state===STATE.READY||state===STATE.OVER){startGame();}
  else if(state===STATE.PAUSE){togglePause();}
});
pauseBtn.addEventListener('click',function(){
  if(state===STATE.PLAY||state===STATE.PAUSE){togglePause();}
});

function setPrimaryLabel(){
  if(state===STATE.READY)primaryBtn.textContent='开始游戏';
  else if(state===STATE.OVER)primaryBtn.textContent='重新开始';
  else if(state===STATE.PAUSE)primaryBtn.textContent='继续';
}

document.addEventListener('keydown',function(e){
  if(e.repeat)return;
  var k=e.code;
  if(k==='ArrowLeft'||k==='KeyA'){keys.left=true;e.preventDefault();}
  else if(k==='ArrowRight'||k==='KeyD'){keys.right=true;e.preventDefault();}
  else if(k==='Space'){if(state===STATE.PLAY||state===STATE.PAUSE){togglePause();}e.preventDefault();}
  else if(k==='Enter'){if(state===STATE.READY||state===STATE.OVER){startGame();}else if(state===STATE.PAUSE){togglePause();}e.preventDefault();}
});
document.addEventListener('keyup',function(e){
  var k=e.code;
  if(k==='ArrowLeft'||k==='KeyA'){keys.left=false;}
  else if(k==='ArrowRight'||k==='KeyD'){keys.right=false;}
});

function bindHold(btn,dir){
  function down(e){e.preventDefault();keys[dir]=true;}
  function up(e){e.preventDefault();keys[dir]=false;}
  btn.addEventListener('pointerdown',down);
  btn.addEventListener('pointerup',up);
  btn.addEventListener('pointerleave',up);
  btn.addEventListener('pointercancel',up);
}
bindHold(leftBtn,'left');
bindHold(rightBtn,'right');

loadImages();
showOverlay('森林金币挑战','操控小狐狸左右移动，接住掉落的金币。<br>每枚金币+5分，漏接三次游戏结束。<br><br>桌面：← → 移动，空格 暂停<br>手机：左右按钮移动','开始游戏',false);
requestAnimationFrame(loop);
})();