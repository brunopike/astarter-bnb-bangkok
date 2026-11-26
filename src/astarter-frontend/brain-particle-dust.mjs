// Render the volume in one point draw, then scatter its light through a mip pyramid.
const phone = {points: 55000, levels: 4, pixels: 480000, dpr: 1.25, fps: 24};
const desktop = {points: 104000, levels: 5, pixels: 1350000, dpr: 1.5, fps: 30};

const dustVertex = `
attribute vec4 aPoint;
uniform float uTime, uPixelRatio;
varying mediump vec3 vLight;
void main() {
  vec2 p = aPoint.xy * 2.12 - 1.06;
  float z = aPoint.z;
  p.x += sin(uTime * .26 + z * 6.28) * (.007 + .038 * z);
  p.y += cos(uTime * .19 + p.x * 2.3 + z * 4.8) * (.006 + .018 * z);
  float lane = p.y + .24 - .33 * sin(p.x * 3.8 + z * 1.5);
  float halo = exp(-lane * lane * 12.0);
  float perimeter = smoothstep(.24, .84, length(p * vec2(1.5, .88)));
  float source = .035 + .17 * halo + .08 * perimeter + .65 * step(.994, aPoint.w);
  source *= (.20 + .65 * z) * (.36 + .64 * perimeter);
  vec3 blue = vec3(.35, .65, .90), violet = vec3(.63, .47, .92);
  vLight = mix(blue, violet, smoothstep(-.8, .8, p.x + .26 * p.y)) * source;
  gl_Position = vec4(p, 0., 1.);
  gl_PointSize = max(1., (.80 + z * .66 + step(.994, aPoint.w) * 1.20) * uPixelRatio);
}`;
const dustFragment = `
precision mediump float;
varying vec3 vLight;
void main() {
  vec2 q = gl_PointCoord * 2. - 1.;
  float light = max(.0, 1. - dot(q, q));
  gl_FragColor = vec4(vLight * light, light);
}`;
const screenVertex = `
attribute vec2 aScreen;
varying mediump vec2 vUV;
void main(){ vUV = .5 + aScreen * .5; gl_Position = vec4(aScreen, 0., 1.); }`;
const blurFragment = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uSource;
uniform vec2 uStep;
void main(){
  vec3 c = texture2D(uSource, vUV).rgb * .28;
  c += .18 * (texture2D(uSource, vUV + uStep).rgb + texture2D(uSource, vUV - uStep).rgb);
  vec2 d = vec2(uStep.x, -uStep.y);
  c += .18 * (texture2D(uSource, vUV + d).rgb + texture2D(uSource, vUV - d).rgb);
  gl_FragColor = vec4(c, 1.);
}`;

function makeProgram(gl, vertex, fragment, attribute) {
  const program = gl.createProgram();
  const shaders = [];
  try {
    for (const [kind, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = gl.createShader(kind);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    gl.bindAttribLocation(program, 0, attribute);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Particle shader unavailable');
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

export function mountParticleDust(canvas, {compact}) {
  const budget = compact ? phone : desktop;
  const win = canvas.ownerDocument.defaultView;
  let visible = false, reduced = false, light = false, disposed = false, failed = false;
  let raf = 0, timer = 0, last = 0, seconds = 0, gl, points, triangle, drawDust, blur, combine;
  let uniforms, locations, targets = [], sizeDirty = true, ratio = 1;

  function release() {
    if (gl && !gl.isContextLost()) {
      for (const target of targets) {
        gl.deleteFramebuffer(target.fb);
        gl.deleteTexture(target.texture);
      }
      for (const buffer of [points, triangle]) if (buffer) gl.deleteBuffer(buffer);
      for (const program of [drawDust, blur, combine]) if (program) gl.deleteProgram(program);
    }
    points = triangle = drawDust = blur = combine = null;
    targets = [];
    sizeDirty = true;
  }

  function setup() {
    gl = canvas.getContext('webgl', {alpha: true, antialias: false, depth: false, stencil: false});
    if (!gl) throw new Error('WebGL unavailable');
    const levels = Array.from({length: budget.levels + 1}, (_, i) => 'uLevel' + i);
    drawDust = makeProgram(gl, dustVertex, dustFragment, 'aPoint');
    blur = makeProgram(gl, screenVertex, blurFragment, 'aScreen');
    const sum = levels.map((name, i) => `texture2D(${name}, vUV).rgb * ${i ? (.32 + i * .13).toFixed(2) : '1.0'}`).join(' + ');
    combine = makeProgram(gl, screenVertex, `
      precision mediump float;
      varying vec2 vUV;
      uniform float uLightMode;
      ${levels.map(name => 'uniform sampler2D ' + name + ';').join('\n')}
      void main(){
        vec3 c = min(vec3(.85), ${sum});
        float a = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(mix(c, c * .32, uLightMode), a);
      }`, 'aScreen');
    uniforms = {time: gl.getUniformLocation(drawDust, 'uTime'), ratio: gl.getUniformLocation(drawDust, 'uPixelRatio'),
      step: gl.getUniformLocation(blur, 'uStep'), light: gl.getUniformLocation(combine, 'uLightMode')};
    locations = levels.map(name => gl.getUniformLocation(combine, name));
    // Four normalized 16-bit values per particle, uploaded only once per context.
    const samples = new Uint16Array(budget.points * 4);
    let seed = 177059;
    for (let i = 0; i < samples.length; i++) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      samples[i] = seed >>> 16;
    }
    points = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, points);
    gl.bufferData(gl.ARRAY_BUFFER, samples, gl.STATIC_DRAW);
    triangle = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    for (let i = 0; i <= budget.levels; i++) {
      const texture = gl.createTexture(), fb = gl.createFramebuffer();
      targets.push({texture, fb, width: 0, height: 0});
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    }
  }

  function layout() {
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    ratio = Math.min(win.devicePixelRatio || 1, budget.dpr, Math.sqrt(budget.pixels / (w*h)));
    let width = Math.max(1, Math.round(w*ratio)), height = Math.max(1, Math.round(h*ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    for (const target of targets) {
      if (target.width !== width || target.height !== height) {
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Particle target unavailable');
        target.width = width; target.height = height;
      }
      width = Math.max(1, width >> 1); height = Math.max(1, height >> 1);
    }
    sizeDirty = false;
  }

  function draw(time) {
    raf = 0;
    if (!visible || failed || disposed) return;
    if (last && !reduced) seconds += Math.min(time - last, 120) / 1000;
    last = time;
    try {
      if (!points) setup();
      if (sizeDirty) layout();
      const base = targets[0];
      gl.bindFramebuffer(gl.FRAMEBUFFER, base.fb);
      gl.viewport(0, 0, base.width, base.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(drawDust);
      gl.uniform1f(uniforms.time, seconds);
      gl.uniform1f(uniforms.ratio, ratio);
      gl.bindBuffer(gl.ARRAY_BUFFER, points);
      gl.vertexAttribPointer(0, 4, gl.UNSIGNED_SHORT, true, 0, 0);
      gl.drawArrays(gl.POINTS, 0, budget.points);
      gl.disable(gl.BLEND);
      gl.useProgram(blur);
      gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      for (let i = 1; i < targets.length; i++) {
        const src = targets[i-1], dest = targets[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fb);
        gl.viewport(0, 0, dest.width, dest.height);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform2f(uniforms.step, 1.4/src.width, 1.4/src.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.useProgram(combine);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, base.width, base.height);
      for (let i = 0; i < targets.length; i++) {
        gl.activeTexture(gl.TEXTURE0+i);
        gl.bindTexture(gl.TEXTURE_2D, targets[i].texture);
        gl.uniform1i(locations[i], i);
      }
      gl.uniform1f(uniforms.light, Number(light));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } catch {
      failed = true;
      release();
      return;
    }
    if (!reduced) timer = win.setTimeout(() => {timer = 0; wake();}, Math.max(0, 1000/budget.fps - 8 - (win.performance.now()-time)));
  }
  function wake() {
    if (visible && !failed && !disposed && !raf && !timer) raf = win.requestAnimationFrame(draw);
  }
  function stop() {
    win.cancelAnimationFrame(raf); win.clearTimeout(timer); raf = timer = last = 0;
  }
  function lost(event) {event.preventDefault(); failed = true; stop(); release();}
  function restored() {failed = false; wake();}
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  const resize = new win.ResizeObserver(() => {sizeDirty = true; wake();});
  resize.observe(canvas);
  return {
    update(state) {
      const changed = light !== state.light || reduced !== state.reduced || visible !== state.visible;
      visible = state.visible; reduced = state.reduced; light = state.light;
      if (changed) {stop(); wake();}
    },
    dispose() {
      disposed = true; stop(); resize.disconnect(); release();
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
    }
  };
}
