import * as T from 'three';
import {solveLeg,pedalAt} from './kinematics.js';
const Y=new T.Vector3(0,1,0),v=p=>new T.Vector3(...p);
export function createWorld(scene){
 const makeMat=(color,roughness=.65,metalness=0)=>new T.MeshStandardMaterial({color,roughness,metalness});
 const m={ivory:makeMat('#fff6db',.42),feather:makeMat('#d8d9c7'),darkFeather:makeMat('#647777'),orange:makeMat('#eda84d',.4),pouch:makeMat('#e78e51',.54),ink:makeMat('#213b3d',.32),tire:makeMat('#253c3e',.94),rubber:makeMat('#c3b395'),rim:makeMat('#efe0bd',.33,.48),chrome:makeMat('#bcd4c5',.26,.65),coral:makeMat('#de6041',.32,.12),scarf:makeMat('#d34f35',.68),sand:makeMat('#e7d0a4'),cliff:makeMat('#c0ae8b'),road:makeMat('#788b7c',.95),mark:makeMat('#dedfc7'),grass:makeMat('#789b7e'),grass2:makeMat('#adc196'),wood:makeMat('#9d7562'),white:makeMat('#fff1d0'),red:makeMat('#d86b51'),black:makeMat('#192c34'),glow:new T.MeshStandardMaterial({color:'#ffd495',emissive:'#ffc16e',emissiveIntensity:.8})};
 const all=[];
 function mesh(g,mat,parent=scene,x=0,y=0,z=0){const o=new T.Mesh(g,mat);o.position.set(x,y,z);o.castShadow=true;o.receiveShadow=true;parent.add(o);all.push(o);return o;}
 const sphere=new T.SphereGeometry(1,32,20);
 function ell(parent,mat,pos,scale,rz=0){const o=mesh(sphere,mat,parent,...pos);o.scale.set(...scale);o.rotation.z=rz;return o;}
 function rod(parent,a,b,r,mat,r2=r){const d=v(b).sub(v(a));const o=mesh(new T.CylinderGeometry(r2,r,d.length(),12),mat,parent);o.position.copy(v(a).add(v(b)).multiplyScalar(.5));o.quaternion.setFromUnitVectors(Y,d.normalize());return o;}
 function liveRod(parent,r,mat){return mesh(new T.CylinderGeometry(r,r,1,10),mat,parent);}
 function setRod(o,a,b){const d=v(b).sub(v(a));o.position.copy(v(a).add(v(b)).multiplyScalar(.5));o.scale.y=d.length();o.quaternion.setFromUnitVectors(Y,d.normalize());}
 function curve(parent,points,r,mat){return mesh(new T.TubeGeometry(new T.CatmullRomCurve3(points.map(v)),40,r,12,false),mat,parent);}
 function torus(parent,R,r,mat,pos,arc=Math.PI*2){return mesh(new T.TorusGeometry(R,r,10,64,arc),mat,parent,...pos);}
 function roundShape(w,h,r){const s=new T.Shape();s.moveTo(-w/2+r,-h/2);s.lineTo(w/2-r,-h/2);s.quadraticCurveTo(w/2,-h/2,w/2,-h/2+r);s.lineTo(w/2,h/2-r);s.quadraticCurveTo(w/2,h/2,w/2-r,h/2);s.lineTo(-w/2+r,h/2);s.quadraticCurveTo(-w/2,h/2,-w/2,h/2-r);s.lineTo(-w/2,-h/2+r);s.quadraticCurveTo(-w/2,-h/2,-w/2+r,-h/2);return s;}
 function slab(parent,w,h,r,depth,mat,y){const o=mesh(new T.ExtrudeGeometry(roundShape(w,h,r),{depth,bevelEnabled:true,bevelSegments:3,steps:1,bevelSize:.10,bevelThickness:.09,curveSegments:28}),mat,parent,0,y,0);o.rotation.x=-Math.PI/2;return o;}
 const coast=new T.Group();scene.add(coast);
 // The entire coastline is an intentionally small, crafted display model.
 const oceanBase=mesh(new T.CylinderGeometry(6.25,6.05,.32,100),makeMat('#659e95',.48),coast,0,-.57,0);oceanBase.scale.z=.70;
 const seaGeom=new T.CircleGeometry(6.21,120);seaGeom.rotateX(-Math.PI/2);seaGeom.scale(1,1,.70);
 const seaMat=new T.ShaderMaterial({uniforms:{time:{value:0},night:{value:0}},vertexShader:`varying vec3 p;void main(){p=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,fragmentShader:`uniform float time;uniform float night;varying vec3 p;void main(){float w=sin(p.x*5.+p.z*11.-time*1.3)*sin(p.z*4.+p.x*2.+time*.7);float s=pow(max(0.,sin(p.x*13.+p.z*21.+time*1.7)),18.);vec3 a=mix(vec3(.30,.62,.60),vec3(.08,.27,.34),night);vec3 b=mix(vec3(.67,.82,.71),vec3(.28,.57,.60),night);vec3 c=mix(a,b,.42+w*.12+s*.12);gl_FragColor=vec4(c,1.);}`,side:T.DoubleSide});
 const sea=mesh(seaGeom,seaMat,coast,0,-.40,0);sea.castShadow=false;
 const land=slab(coast,10.8,3.25,1.35,.31,m.cliff,-.34);
 slab(coast,10.65,3.1,1.35,.08,m.sand,-.03);
 slab(coast,10.65,1.47,.61,.015,m.road,.075);
 // Sidewalk borders and rolling lane markers.
 [-.78,.78].forEach(z=>rod(coast,[-4.55,.105,z],[4.55,.105,z],.029,m.white));
 const markers=[];
 for(let i=0;i<12;i++){const o=mesh(new T.BoxGeometry(.4,.012,.032),m.mark,coast,-5+i*.86,.107,-.03);markers.push(o);}
 // Foam on the shoreline, built from individual flowing curves.
 const foam=[];
 for(let i=0;i<8;i++){const x=-4.7+i*1.28;let o=curve(coast,[[x,-.375,2.0],[x+.3,-.37,2.08],[x+.63,-.375,2.05]],.016,makeMat('#d7e6ce'));o.castShadow=false;foam.push(o);}
 // Rocks and grasses. Fixed seed by index, no randomized assets.
 for(let i=0;i<23;i++){const x=-5+i*.45;const z=(i%2?-1:1)*(1.13+.15*Math.sin(i*7.3));if(Math.abs(x)<1.7&&z>0)continue;const g=new T.Group();g.position.set(x,.18,z);coast.add(g);for(let j=0;j<4;j++){let a=j*1.72+i;curve(g,[[0,0,0],[Math.cos(a)*.09,.18+((i+j)%3)*.045,Math.sin(a)*.09],[Math.cos(a)*.16,.23+((i+j)%3)*.06,Math.sin(a)*.16]],.016,j%2?m.grass:m.grass2);}}
 for(let i=0;i<9;i++){const x=-4.6+i*1.19;const o=mesh(new T.IcosahedronGeometry(.3+(i%3)*.06,1),i%2?m.cliff:m.sand,coast,x,-.27,1.7+(i%2)*.10);o.scale.set(1.3,.5,.8);o.rotation.set(i,0,i*.4);}
 // A tiny lighthouse behind the rider.
 const lightHouse=new T.Group();coast.add(lightHouse);lightHouse.position.set(-3.8,.14,-1.06);
 mesh(new T.CylinderGeometry(.55,.66,.12,40),m.sand,lightHouse,0,.02,0);
 for(let i=0;i<5;i++)mesh(new T.CylinderGeometry(.27-i*.018,.29-i*.018,.24,40),i%2?m.red:m.white,lightHouse,0,.18+i*.24,0);
 mesh(new T.CylinderGeometry(.26,.26,.05,36),m.ink,lightHouse,0,1.33,0);
 mesh(new T.CylinderGeometry(.18,.18,.24,24),new T.MeshStandardMaterial({color:'#fff0ae',emissive:'#ffd580',emissiveIntensity:.4,transparent:true,opacity:.68}),lightHouse,0,1.47,0);
 for(let i=0;i<6;i++){const a=i*Math.PI/3;rod(lightHouse,[.185*Math.cos(a),1.34,.185*Math.sin(a)],[.185*Math.cos(a),1.6,.185*Math.sin(a)],.018,m.ink);}
 mesh(new T.ConeGeometry(.31,.23,32),m.red,lightHouse,0,1.71,0);
 ell(lightHouse,m.ink,[0,1.85,0],[.035,.075,.035]);
 mesh(new T.BoxGeometry(.13,.27,.01),m.ink,lightHouse,0,.27,.29);
 const beacon=new T.PointLight('#ffcd83',0,8,2);beacon.position.set(-3.8,1.66,-1.06);coast.add(beacon);
 // Coastal signpost and simple wooden rail, well away from the bicycle.
 const bench=new T.Group();coast.add(bench);bench.position.set(3.6,.16,-1.05);
 for(let i=0;i<3;i++)mesh(new T.BoxGeometry(1.05,.055,.10),m.wood,bench,0,.33,-.15+i*.14);
 [-.4,.4].forEach(x=>{rod(bench,[x,0,-.10],[x,.31,-.10],.035,m.ink);rod(bench,[x,0,.16],[x,.65,-.18],.035,m.ink);});
 for(let i=0;i<2;i++)mesh(new T.BoxGeometry(1.08,.10,.055),m.wood,bench,0,.47+i*.15,-.17);
 // Bicycle points: a real pair of connected frame triangles.
 const rider=new T.Group();scene.add(rider);rider.position.y=.11;
 const bike=new T.Group();rider.add(bike);
 const wheels=[];
 for(const x of [-1.3,1.22]){const g=new T.Group();g.position.set(x,.61,0);bike.add(g);wheels.push(g);
 torus(g,.54,.073,m.tire,[0,0,0]);torus(g,.54,.049,m.rubber,[0,0,.023]);torus(g,.494,.023,m.rim,[0,0,0]);
 for(let i=0;i<24;i++){const a=i*Math.PI/12;rod(g,[0,0,(i%2?1:-1)*.07],[Math.cos(a)*.481,Math.sin(a)*.481,0],.0055,m.chrome);}
 const hub=rod(g,[0,0,-.1],[0,0,.1],.042,m.chrome);
 torus(g,.17,.013,m.chrome,[0,0,.07]);
 }
 const rear=[-1.3,.61,0],front=[1.22,.61,0],crank=[-.08,.79,0],seat=[-.42,1.55,0],head=[.85,1.55,0];
 [[seat,crank],[seat,head],[head,crank],[seat,rear],[rear,crank]].forEach(([a,b])=>rod(bike,a,b,.043,m.coral));
 rod(bike,[.9,1.67,0],front,.034,m.coral);rod(bike,[.9,1.67,0],[.86,1.9,0],.025,m.chrome);
 rod(bike,seat,[-.47,1.73,0],.028,m.chrome);ell(bike,m.ink,[-.5,1.74,0],[.27,.055,.16]);
 curve(bike,[[.86,1.88,0],[.80,1.96,.22],[.99,1.89,.33],[.90,1.74,.34],[.75,1.74,.34]],.025,m.chrome);
 curve(bike,[[.86,1.88,0],[.80,1.96,-.22],[.99,1.89,-.33],[.90,1.74,-.34],[.75,1.74,-.34]],.025,m.chrome);
 [-1,1].forEach(s=>rod(bike,[.76,1.74,s*.34],[.89,1.75,s*.34],.039,m.ink));
 const gear=torus(bike,.165,.024,m.chrome,[-.08,.79,.115]);
 curve(bike,[[-1.3,.7,.13],[-.08,.955,.13],[.086,.79,.13],[-.08,.624,.13],[-1.3,.51,.13],[-1.40,.61,.13],[-1.3,.7,.13]],.010,m.ink);
 torus(bike,.095,.018,m.chrome,[-1.3,.61,.13]);
 const cranks=[],feet=[],legs=[];
 const footShape=new T.Shape();footShape.moveTo(-.14,-.055);footShape.lineTo(.15,-.15);footShape.quadraticCurveTo(.27,-.1,.17,-.045);footShape.lineTo(.30,0);footShape.quadraticCurveTo(.32,.055,.18,.06);footShape.lineTo(.24,.14);footShape.quadraticCurveTo(.17,.21,-.12,.08);footShape.closePath();
 for(let s of [-1,1]){
 cranks.push({o:liveRod(bike,.024,m.chrome),s});
 const foot=new T.Group();bike.add(foot);mesh(new T.BoxGeometry(.26,.05,.18),m.ink,foot,0,-.025,0);
 const web=mesh(new T.ExtrudeGeometry(footShape,{depth:.035,bevelEnabled:true,bevelSize:.012,bevelThickness:.01,bevelSegments:2}),m.orange,foot,.01,.025,0);web.rotation.x=-Math.PI/2;
 feet.push({o:foot,s});legs.push({upper:liveRod(bike,.047,m.orange),lower:liveRod(bike,.036,m.orange),knee:ell(bike,m.orange,[0,0,0],[.063,.063,.063]),s});
 }
 // Small details make the model read as an object, rather than a symbol.
 rod(bike,[-1.57,1.31,-.18],[-.83,1.31,-.18],.017,m.chrome);rod(bike,[-1.57,1.31,.18],[-.83,1.31,.18],.017,m.chrome);
 for(let i=0;i<5;i++)rod(bike,[-1.5+i*.15,1.31,-.18],[-1.5+i*.15,1.31,.18],.014,m.chrome);
 [-1,1].forEach(s=>rod(bike,[-1.3,.61,s*.09],[-1.5,1.31,s*.18],.017,m.chrome));
 const bag=ell(bike,makeMat('#788d68'),[-1.23,1.1,-.28],[.27,.30,.15]);
 rod(bike,[-1.23,1.35,-.44],[-1.23,.98,-.44],.025,m.wood);
 const lamp=ell(bike,m.ink,[1.0,1.47,0],[.13,.12,.12]);ell(bike,m.glow,[1.11,1.47,0],[.018,.08,.08]);
 // Body, S-shaped neck, lower bill pouch, layered primary feathers.
 const bird=new T.Group();rider.add(bird);
 ell(bird,m.ivory,[-.48,2.19,0],[.75,.54,.44],.13);
 ell(bird,m.feather,[-.9,2.21,-.08],[.52,.31,.35],-.10);
 for(let i=0;i<5;i++)ell(bird,i<2?m.darkFeather:m.feather,[-1.15-i*.09,2.22-i*.028,(i-2)*.055],[.35,.075,.09],.07+i*.035);
 curve(bird,[[-.06,2.29,0],[.16,2.61,0],[.06,2.94,0],[.32,3.23,0],[.56,3.32,0]],.20,m.ivory);
 ell(bird,m.ivory,[.53,3.34,0],[.38,.34,.285],.1);
 ell(bird,m.ivory,[.31,3.59,0],[.17,.15,.19],.35);
 const beak=mesh(new T.ConeGeometry(1,1,40),m.orange,bird,1.31,3.30,0);beak.rotation.z=-Math.PI/2;beak.scale.set(.11,1.30,.19);
 ell(bird,m.pouch,[1.06,3.16,0],[.64,.20,.185],.13);
 curve(bird,[[.71,3.26,.17],[1.21,3.275,.115],[1.93,3.296,0]],.011,makeMat('#bb753c'));
 for(const s of [-1,1]){
 ell(bird,m.orange,[.60,3.43,s*.265],[.123,.14,.04]);ell(bird,m.black,[.617,3.448,s*.30],[.067,.076,.027]);ell(bird,m.white,[.638,3.475,s*.32],[.018,.024,.01]);
 // shoulder and stretched wing to the handlebar
 ell(bird,m.ivory,[-.49,2.28,s*.39],[.53,.28,.13],-.28);
 for(let i=0;i<4;i++)ell(bird,i===3?m.darkFeather:m.feather,[-.11+i*.14,2.16-i*.078,s*(.40-i*.015)],[.37-i*.035,.085,.075],-.40-i*.07);
 curve(bird,[[.24,2.04,s*.38],[.5,1.91,s*.35],[.79,1.78,s*.34]],.070,m.ivory);
 }
 // A scarf wrapped around the base of the neck, with a deforming ribbon.
 const collar=torus(bird,.20,.075,m.scarf,[.085,2.73,0]);collar.rotation.x=Math.PI/2;collar.rotation.z=-.2;
 const scarfGeo=new T.PlaneGeometry(1.35,.19,28,3);const scarfMat=new T.MeshStandardMaterial({color:'#d34f35',roughness:.7,side:T.DoubleSide});
 const scarf=mesh(scarfGeo,scarfMat,bird,-.59,2.75,-.12);scarf.rotation.x=.1;
 const scarfBase=Float32Array.from(scarfGeo.attributes.position.array);
 // Background gulls, clouds and a few warm fireflies after dark.
 const atmosphere=new T.Group();scene.add(atmosphere);
 const gulls=[];
 for(let i=0;i<3;i++){let g=new T.Group();atmosphere.add(g);for(const s of [-1,1])curve(g,[[0,0,0],[s*.2,.12,0],[s*.42,.04,.02]],.020,m.ivory);gulls.push(g);}
 const clouds=[];for(let i=0;i<3;i++){const g=new T.Group();g.position.set(-3+i*3.8,3.6+(i%2)*.5,-2.7-i*.2);atmosphere.add(g);[[0,0,0,.55],[.45,-.05,0,.35],[-.44,-.10,0,.33]].forEach(([x,y,z,s])=>ell(g,m.white,[x,y,z],[s,s*.31,s*.35]));clouds.push(g);}
 const fireflies=[];for(let i=0;i<18;i++){const o=ell(atmosphere,new T.MeshBasicMaterial({color:'#f7d78b'}),[0,0,0],[.018,.018,.018]);o.castShadow=false;fireflies.push(o);}
 const studio=new T.Group();scene.add(studio);studio.visible=false;
 const platform=mesh(new T.CylinderGeometry(2.8,2.9,.20,100),makeMat('#d8dfcb',.55),studio,0,-.02,0);platform.scale.z=.61;
 const studioRing=torus(studio,2.7,.012,m.rim,[0,.091,0]);studioRing.rotation.x=-Math.PI/2;studioRing.scale.y=.61;
 // Soft contact shadow on a broad background-free floor.
 const floor=mesh(new T.PlaneGeometry(200,200),new T.ShadowMaterial({color:'#263e39',opacity:.12}),scene,0,-.76,0);floor.rotation.x=-Math.PI/2;floor.castShadow=false;
 const hemi=new T.HemisphereLight('#fff5db','#6f8c80',2.4);scene.add(hemi);
 const sun=new T.DirectionalLight('#ffe1ae',3.8);sun.position.set(-3,7,5);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-8,right:8,top:7,bottom:-5,near:.1,far:24});sun.shadow.normalBias=.025;sun.shadow.bias=-.00006;sun.shadow.radius=3;scene.add(sun);
 const fill=new T.DirectionalLight('#d2e9ee',1.2);fill.position.set(4,4,-5);scene.add(fill);
 const frontLight=new T.PointLight('#ffc981',0,5,2);frontLight.position.set(1.35,1.6,0);rider.add(frontLight);
 const palettes={day:{hemi:'#e8f6ff',ground:'#81a791',sun:'#fff6d8',intensity:3.4,ambient:2.4,fill:1.3,night:0},sunset:{hemi:'#fff0d0',ground:'#a29581',sun:'#ffd093',intensity:3.8,ambient:2.2,fill:1.3,night:0},night:{hemi:'#b1dcf0',ground:'#34516d',sun:'#a8dae6',intensity:2.3,ambient:1.25,fill:2,night:1}};
 const blended={...palettes.sunset};let theme='sunset',mode='coast';const temp=new T.Color();
 function lighting(light){theme=light;}
 function setMode(value){mode=value;coast.visible=value==='coast';atmosphere.visible=value==='coast';studio.visible=value==='studio';}
 function renderAt(time,travel){
  const wheelAngle=-travel/.54,crankAngle=-travel*2.0;
  wheels.forEach(w=>w.rotation.z=wheelAngle);
  for(const {o,s} of cranks){const p=pedalAt(crankAngle,s);setRod(o,[-.08,.79,s*.18],[p.x,p.y,p.z]);}
  for(const {o,s} of feet){const p=pedalAt(crankAngle,s);o.position.set(p.x,p.y,p.z);}
  for(const {upper,lower,knee,s} of legs){const p=pedalAt(crankAngle,s),hip={x:-.43,y:1.79},k=solveLeg(hip,p);setRod(upper,[hip.x,hip.y,s*.24],[k.x,k.y,s*.31]);setRod(lower,[k.x,k.y,s*.31],[p.x-.045,p.y+.075,p.z]);knee.position.set(k.x,k.y,s*.31);}
  bird.position.y=Math.sin(crankAngle*2)*.015;
  const attr=scarfGeo.attributes.position;
  for(let i=0;i<attr.count;i++){const x=scarfBase[i*3],u=(.675-x)/1.35;attr.setXYZ(i,x,scarfBase[i*3+1]+Math.sin(time*8-u*7)*.065*u,Math.sin(time*6-u*8)*.11*u);}
  attr.needsUpdate=true;scarfGeo.computeVertexNormals();
  markers.forEach((o,i)=>o.position.x=((i*.86-travel*.8)%10.32+10.32)%10.32-5.16);
  seaMat.uniforms.time.value=time;
  foam.forEach((o,i)=>{o.position.z=Math.sin(time*.65+i)*.06;o.scale.x=1+Math.sin(time*.7+i)*.05;});
  gulls.forEach((g,i)=>{g.position.set(Math.sin(time*.12+i*2)*4.6,3.7+Math.sin(time*.7+i)*.12,-2.2-i*.28);g.rotation.z=Math.sin(time*1.5+i)*.05;g.rotation.y=-.3;});
  clouds.forEach((g,i)=>g.position.x=-3+i*3.8+Math.sin(time*.08+i)*.25);
  const p=palettes[theme],k=.045;
  hemi.color.lerp(temp.set(p.hemi),k);hemi.groundColor.lerp(temp.set(p.ground),k);sun.color.lerp(temp.set(p.sun),k);
  sun.intensity+=(p.intensity-sun.intensity)*k;hemi.intensity+=(p.ambient-hemi.intensity)*k;fill.intensity+=(p.fill-fill.intensity)*k;
  seaMat.uniforms.night.value+=(p.night-seaMat.uniforms.night.value)*k;
  const night=seaMat.uniforms.night.value;frontLight.intensity=night*2;beacon.intensity=night*2.5;m.glow.emissiveIntensity=.6+night*3;
  fireflies.forEach((o,i)=>{o.visible=night>.25;o.scale.setScalar(.018*night);o.position.set(Math.sin(i*2.7+time*.14)*4.7,.4+((i*.23)%1.6)+Math.sin(time*.8+i)*.1,Math.cos(i*3.9)*2.1);});
 }
 return{renderAt,lighting,setMode,rider,coast,studio,materials:m,counts:()=>({objects:all.length}),scene};
}
