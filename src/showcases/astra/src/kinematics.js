export function solveLeg(hip, foot, upper=.63, lower=.68) {
  const dx=foot.x-hip.x,dy=foot.y-hip.y,d=Math.hypot(dx,dy);
  if (d > upper+lower+1e-8 || d < Math.abs(upper-lower)-1e-8) throw new RangeError('Unreachable pedal');
  const a=(upper*upper-lower*lower+d*d)/(2*d),h=Math.sqrt(Math.max(0,upper*upper-a*a));
  return {x:hip.x+a*dx/d-h*dy/d,y:hip.y+a*dy/d+h*dx/d};
}
export function pedalAt(angle, side=1) {const a=angle+(side<0?Math.PI:0);return {x:-.08+.25*Math.cos(a),y:.79+.25*Math.sin(a),z:side*.32};}
export function smoothstep(x){return x*x*(3-2*x);}
