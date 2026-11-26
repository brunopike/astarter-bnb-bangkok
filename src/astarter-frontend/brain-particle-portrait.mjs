// Cross-sections in head-height units, measured down from the crown.
const head = [
  [0, 0, 0, -.03], [.045, .16, .14, -.04], [.13, .29, .24, -.045],
  [.24, .345, .285, -.036], [.38, .364, .29, -.02], [.49, .35, .278, -.015],
  [.58, .335, .26, -.01], [.68, .324, .24, .015], [.77, .303, .223, .032],
  [.87, .245, .18, .061], [.96, .135, .118, .09], [1.00, 0, 0, .11]
];
const torso = [
  [.79, .177, .158, -.047], [.99, .164, .148, -.061], [1.10, .18, .158, -.041],
  [1.17, .25, .174, -.032], [1.22, .47, .198, -.034], [1.29, .71, .228, -.052],
  [1.39, .87, .279, -.05], [1.52, .96, .304, -.046]
];
const darkTints = ['97,217,237','98,194,226','114,156,210','143,142,211','176,151,227','213,179,244'];
const lightTints = ['12,107,126','22,115,141','54,99,140','91,88,142','106,77,146','116,68,154'];

function section(profile, y) {
  let i=1;
  while(i<profile.length-1 && profile[i][0]<y)i++;
  const a=profile[i-1], b=profile[i];
  const t=(y-a[0])/(b[0]-a[0]);
  return [1,2,3].map(j=>a[j]+t*(b[j]-a[j]));
}

function buildShell(compact) {
  const bands=Array.from({length:6},()=>[]);
  function sample(profile, rows, columns, face) {
    const top=profile[0][0], bottom=profile.at(-1)[0];
    for(let row=0;row<rows;row++){
      const y=top+(bottom-top)*(row+.5)/rows;
      const [width,depth,center]=section(profile,y);
      const n=Math.max(12,Math.round(columns*Math.sqrt(width/(face ? .365 : .96))));
      for(let j=0;j<n;j++){
        const angle=(j+(row%2)*.5)*Math.PI*2/n;
        const side=Math.sin(angle), front=Math.cos(angle), x=width*side;
        let z=center+depth*front, ridge=0;
        if(face && front>0){
          // Sculpt a shallow brow, bridge, cheeks, lips and chin into the front hemisphere.
          const across=Math.abs(x);
          const feature=(cx,cy,rx,ry)=>Math.exp(-(((across-cx)/rx)**2+((y-cy)/ry)**2));
          const relief=.058*feature(.133,.444,.09,.041)-.052*feature(.13,.512,.083,.037)
            +.095*feature(0,.554,.050,.126)+.080*feature(0,.645,.068,.041)
            +.045*feature(.197,.605,.085,.060)+.049*feature(0,.768,.105,.034)
            +.042*feature(0,.894,.100,.060);
          z+=front*front*relief;
          ridge=Math.max(0,Math.min(1,relief*8))*Math.max(front,0);
        }else if(!face && front>0){
          z+=.036*front*Math.exp(-(((y-1.245+.035*Math.cos(7*x))/.033)**2));
        }
        const tint=Math.max(0,Math.min(5,Math.floor(3+2.8*Math.sin(angle+.30))));
        bands[tint].push(x,y,z,side,front,ridge);
      }
    }
  }
  sample(head,compact?62:82,compact?91:119,true);
  sample(torso,compact?29:36,compact?102:126,false);
  return bands.map(points=>new Float32Array(points));
}

function rimGlow(doc) {
  const tile=doc.createElement('canvas');
  tile.width=tile.height=48;
  const ctx=tile.getContext('2d');
  if(!ctx)return null;
  const gradient=ctx.createRadialGradient(24,24,0,24,24,24);
  gradient.addColorStop(0,'rgba(145,188,224,.7)');
  gradient.addColorStop(.34,'rgba(157,190,229,.30)');
  gradient.addColorStop(1,'rgba(157,190,229,0)');
  ctx.fillStyle=gradient;ctx.fillRect(0,0,48,48);
  return tile;
}

export function mountParticlePortrait(canvas) {
  const doc=canvas.ownerDocument,win=doc.defaultView;
  const ctx=canvas.getContext('2d');
  let visible=false,reduced=false,light=false,disposed=false;
  let width=0,height=0,scale=0,originY=0,compact=false,points=null,glow=null;
  let frame=0,timer=0,previous=0,phase=.65;

  function cancel(){
    if(frame)win.cancelAnimationFrame(frame);
    if(timer)win.clearTimeout(timer);
    frame=timer=previous=0;
  }
  function layout(){
    const w=canvas.clientWidth,h=canvas.clientHeight;
    if(!w || !h)return false;
    const small=w<=760 || h<=460;
    const dpr=Math.min(win.devicePixelRatio||1,small?1.4:1.5,Math.sqrt(1100000/(w*h)));
    const pw=Math.max(1,Math.round(w*dpr)),ph=Math.max(1,Math.round(h*dpr));
    if(w===width && h===height && canvas.width===pw && canvas.height===ph)return true;
    if(!points || compact!==small)points=buildShell(small);
    compact=small;width=w;height=h;
    canvas.width=pw;canvas.height=ph;
    ctx.setTransform(pw/w,0,0,ph/h,0,0);
    const top=h<420?16:Math.min(compact?100:68,h*.19);
    const foot=Math.min(52,h*.09);
    scale=Math.min((h-top-foot)/1.52,w*(compact ? .75 : .47));
    originY=top+Math.max(0,(h-top-foot-scale*1.52)*.50);
    glow??=rimGlow(doc);
    return true;
  }
  function draw(now){
    frame=0;
    if(disposed || !visible || doc.hidden || !ctx || !layout())return;
    if(!reduced && previous)phase+=Math.min(120,now-previous)/1000;
    previous=now;
    const time=reduced ? .65 : phase;
    const yaw=-.17+.30*Math.sin(time*.70), pitch=.022+.051*Math.sin(time*.49);
    const sy=Math.sin(yaw),cy=Math.cos(yaw),sp=Math.sin(pitch),cp=Math.cos(pitch);
    const lightSweep=.55+.28*Math.sin(time*.92);
    const tints=light?lightTints:darkTints;
    ctx.clearRect(0,0,width,height);
    for(let b=0;b<points.length;b++){
      const band=points[b];
      ctx.fillStyle='rgb('+tints[b]+')';
      for(let i=0;i<band.length;i+=6){
        const x=band[i], y=band[i+1], z=band[i+2];
        const facing=band[i+4]*cy-band[i+3]*sy;
        if(facing<-.13)continue;
        if(y>.80 && y<.96 && Math.abs(x)<.18 && z<.10)continue;
        const depth=z*cy-x*sy;
        const perspective=1+.13*depth;
        const px=width*.5+(x*cy+z*sy)*scale*perspective;
        const py=originY+(.55+(y-.55)*cp-depth*sp)*scale*perspective;
        const edge=1-Math.abs(facing);
        const rim=edge*edge;
        const wave=Math.max(0,1-Math.abs(y-lightSweep-.09*x)*8);
        const taper=y<=1.34?1:Math.max(.12,(1.57-y)/.23);
        const ridge=band[i+5];
        const intensity=(.18+.70*rim+.12*wave+.32*ridge)*taper;
        ctx.globalAlpha=Math.min(1,intensity*(light?1.19:1));
        const size=Math.min(2.25,Math.max(.96,scale*.0041))*(.84+.85*rim+.20*wave+.20*ridge);
        ctx.fillRect(px,py,size,size);
        if(!light && glow && rim>.69 && (i/6)%3===0){
          const halo=size*5.75;
          ctx.globalAlpha=intensity*.48;
          ctx.drawImage(glow,px-halo/2,py-halo/2,halo,halo);
        }
      }
    }
    ctx.globalAlpha=1;
    if(!reduced){
      const delay=Math.max(0,(compact?1000/24:1000/30)-(win.performance.now()-now)-6);
      timer=win.setTimeout(()=>{timer=0;request();},delay);
    }
  }
  function request(){
    if(!disposed && visible && !doc.hidden && ctx && !frame && !timer)frame=win.requestAnimationFrame(draw);
  }
  function visibility(){
    if(doc.hidden)cancel();else request();
  }
  const resize=new win.ResizeObserver(request);
  resize.observe(canvas);
  doc.addEventListener('visibilitychange',visibility);
  return {
    update(state){
      if(disposed)return;
      const changed=visible!==state.visible || reduced!==state.reduced || light!==state.light;
      visible=state.visible;reduced=state.reduced;light=state.light;
      if(changed){cancel();request();}
    },
    dispose(){
      disposed=true;cancel();resize.disconnect();doc.removeEventListener('visibilitychange',visibility);
      points=glow=null;
      canvas.width=canvas.height=1;
    }
  };
}
