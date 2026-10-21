const STAGE_ID = 'ludoready-host-stage';

/** The host owns this outer stage; the production game's DOM stays intact. */
export function wrapGameViewport(bodyFragment: string): string {
  if (/\bid=["']ludoready-host-stage["']/u.test(bodyFragment)) return bodyFragment;
  return `<div id="${STAGE_ID}">${bodyFragment}</div>`;
}

// Fitting games keep their original body layout. The active rule centers the
// whole natural-size UI before applying one uniform visual scale.
export const GAME_VIEWPORT_CSS = `
#${STAGE_ID}{display:contents}
html[data-ludoready-viewport-fit] body{position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:center!important;overflow:visible!important}
html[data-ludoready-viewport-fit] #${STAGE_ID}{display:block!important;position:relative!important;flex:0 0 auto!important;width:max-content!important;height:max-content!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;transform-origin:center!important;transform:translate(var(--ludoready-viewport-x,0px),var(--ludoready-viewport-y,0px)) scale(var(--ludoready-viewport-scale,1))!important}
`;

/** Save as public/viewport.js and load after the game's stylesheet and script. */
export const GAME_VIEWPORT_SCRIPT = `(() => {
'use strict';
const stage=document.getElementById('${STAGE_ID}');
if(!stage)return;
const html=document.documentElement,attribute='data-ludoready-viewport-fit';
let pending=false;
function layoutNodes(){return [...new Set([...stage.children,...stage.querySelectorAll('canvas,[data-game-root]')])];}
function bounds(){
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  // Moving entities inside a clipped scene never change the layout bounds.
  for(const node of layoutNodes()){
    const rect=node.getBoundingClientRect();
    if(!rect.width||!rect.height)continue;
    left=Math.min(left,rect.left);top=Math.min(top,rect.top);
    right=Math.max(right,rect.right);bottom=Math.max(bottom,rect.bottom);
  }
  return {left,top,right,bottom,width:right-left,height:bottom-top};
}
function fit(){
  pending=false;
  // Measure the original layout every time, so positional clipping cannot toggle
  // between the original and centered layouts on successive resize observations.
  html.removeAttribute(attribute);
  for(const name of ['scale','x','y'])stage.style.removeProperty('--ludoready-viewport-'+name);
  let content=bounds();
  if(!Number.isFinite(content.width)||!Number.isFinite(content.height))return;
  const availableWidth=window.innerWidth,availableHeight=window.innerHeight;
  if(content.left>=-0.5&&content.top>=-0.5&&content.right<=availableWidth+0.5&&content.bottom<=availableHeight+0.5)return;
  html.setAttribute(attribute,'');
  content=bounds();
  const scale=Math.min(1,availableWidth/content.width,availableHeight/content.height);
  const stageRect=stage.getBoundingClientRect();
  const stageX=(stageRect.left+stageRect.right)/2,stageY=(stageRect.top+stageRect.bottom)/2;
  const contentX=(content.left+content.right)/2,contentY=(content.top+content.bottom)/2;
  stage.style.setProperty('--ludoready-viewport-scale',String(scale));
  stage.style.setProperty('--ludoready-viewport-x',(availableWidth/2-stageX-(contentX-stageX)*scale)+'px');
  stage.style.setProperty('--ludoready-viewport-y',(availableHeight/2-stageY-(contentY-stageY)*scale)+'px');
}
function schedule(){if(!pending){pending=true;requestAnimationFrame(fit);}}
const resize=new ResizeObserver(schedule);
function observe(){resize.observe(stage);for(const node of layoutNodes())resize.observe(node);}
observe();
new MutationObserver(records=>{
  if(records.some(record=>record.type==='childList'||record.target!==stage)){observe();schedule();}
}).observe(stage,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden']});
window.addEventListener('resize',schedule);
schedule();
})();
`;
