import * as THREE from 'three';

/* ==========================================================================
   ROCKET LEAGUE ARENA  —  v3
   --------------------------------------------------------------------------
   Built to *authentic* Rocket League proportions and rescaled 1:14 from the
   real game's Unreal units, so the mechanics behave the way they do in RL:

     RL (uu)              x 1/14        here
     field 8192 x 10240    ->           585 x 732 x 146
     goal  1786 x 643      ->           128 x 46
     ball  r 92.75         ->           r 6.6
     car   118 x 84 x 36   ->           8.4 x 6.0 x 2.6
     gravity 650           ->           46
     jump    290           ->           21
     boost   991           ->           71  (x1.45 for feel)
     max spd 1410/2200     ->           100 / 162

   The whole bowl is a single *rounded box* signed-distance field, so the
   floor curves smoothly up into every wall and the walls curve into the
   ceiling: you can drive up the walls anywhere, exactly like RL.
   ========================================================================== */

const CFG = {
  /* ---- arena (half extents) ---- */
  fieldX: 300, fieldZ: 375, fieldY: 150,
  corner: 22,                 // floor->wall and wall->ceiling fillet radius

  /* ---- goals ---- */
  goalHalfW: 64, goalH: 46, goalDepth: 62,

  /* ---- ball ---- */
  ballR: 6.6,
  ballGravity: 46,
  ballRest: 0.60,
  ballDrag: 0.99955,
  ballSpinDecay: 0.9965,
  magnus: 0.0016,
  ballMaxSpeed: 420,
  ballRollFriction: 0.22,     // so a rolling ball settles instead of rolling forever

  /* ---- car ---- */
  carHalf: { x: 3.0, y: 1.3, z: 4.3 },
  carOffsetY: -0.2,
  carR: 4.6,
  carRide: 1.95,
  carAccel: 74,
  carMaxSpeed: 100,
  carBoostSpeed: 162,
  carTurn: 2.2,
  /* tyre model: the front axle bites harder than the rear, so the car pivots
     into a corner by itself and can be made to break traction */
  carGripFront: 13.0,
  carGripRear: 9.0,
  carYawFromSlip: 0.11,
  carDriftGrip: 1.9,          // scales both axles while handbraking
  carRollFriction: 0.30,      // coasting: was 2.0, which felt like driving in mud
  carThrottleDrag: 0.30,
  carAirDrag: 0.25,           // stops the car flying in a straight line forever
  carAlignRate: 18,           // how fast the hull settles onto the surface
  gravity: 46,
  jumpV: 23,
  flipSpeed: 62,
  flipSpin: 21,
  airPitch: 9.0,
  airYaw: 6.0,
  airRoll: 9.0,
  stickSpeed: 22,
  stickAlign: 0.15,

  /* ---- boost ---- */
  boostMax: 100, boostUse: 33, boostAccel: 104, supersonic: 157,

  /* ---- guns ---- */
  bulletSpeed: 330, bulletLife: 1.5, bulletR: 1.5,
  bulletImpulse: 150, carBulletImpulse: 60,
  gunCooldown: 0.24, magSize: 14, reloadTime: 1.5,

  /* ---- match ---- */
  matchTime: 300, demoTime: 3.0,
};

const STEP = 1 / 120;
const UPV = new THREE.Vector3(0, 1, 0);

/* ==========================================================================
   AUDIO
   ========================================================================== */
const Sound = (() => {
  let ctx = null, master = null;
  function init() {
    if (ctx) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.26;
      master.connect(ctx.destination);
    } catch (e) { ctx = null; }
  }
  function tone(f, dur, type, vol, slide) {
    if (!ctx) return;
    type = type || 'sine'; vol = vol === undefined ? 1 : vol; slide = slide || 0;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, ctx.currentTime);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(28, f + slide), ctx.currentTime + dur);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g); g.connect(master);
    o.start(); o.stop(ctx.currentTime + dur + 0.02);
  }
  function noise(dur, vol, freq) {
    if (!ctx) return;
    vol = vol === undefined ? 0.4 : vol; freq = freq || 900;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(master); src.start();
  }
  return {
    init,
    hit() { tone(70, 0.22, 'square', 0.5, -42); noise(0.18, 0.34, 600); },
    bigHit() { tone(46, 0.42, 'sawtooth', 0.8, -22); noise(0.36, 0.5, 420); },
    wall() { tone(165, 0.09, 'square', 0.15, -70); },
    shoot() { tone(880, 0.07, 'square', 0.22, -600); },
    jump() { tone(310, 0.12, 'sine', 0.25, 240); },
    flip() { tone(220, 0.18, 'triangle', 0.3, 400); },
    boost() { tone(160, 0.06, 'sawtooth', 0.075, 70); },
    supersonic() { tone(920, 0.24, 'sine', 0.15, 520); },
    pad() { tone(900, 0.13, 'triangle', 0.22, 540); },
    bigPad() { [660, 990, 1320].forEach((f, i) => setTimeout(() => tone(f, 0.2, 'triangle', 0.22), i * 65)); },
    goal() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.5, 'triangle', 0.4), i * 92)); },
    demo() { noise(0.55, 0.9, 340); tone(60, 0.55, 'sawtooth', 0.6, -34); },
    hurt() { tone(130, 0.28, 'sawtooth', 0.32, -80); },
    whistle() { tone(1500, 0.45, 'sine', 0.22, 260); },
  };
})();

/* ==========================================================================
   RENDERER / SCENE / CAMERA
   ========================================================================== */
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });

/* ---- adaptive quality ----------------------------------------------------
   A 2x device pixel ratio combined with bloom + a transmission-free but still
   heavy scene was the main cause of the lag. We start at a sane ratio and then
   walk resolution / post effects up or down to hold a smooth frame rate. */
const MAX_DPR = Math.min(window.devicePixelRatio || 1, 1.5);
let renderScale = 1;      // 0.6 .. 1.0 multiplier on top of MAX_DPR
let qualityLevel = 2;     // 2 = bloom + motion blur, 1 = bloom only, 0 = neither

function applyRenderScale() {
  renderer.setPixelRatio(Math.max(0.6, MAX_DPR * renderScale));
}
applyRenderScale();
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;   // refreshed on a timer instead of every frame
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050810, 0.00095);

const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 1.0, 4000);

/* ---- procedural sky/reflection environment ---- */
function makeEnvTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.00, '#0a1430');
  grad.addColorStop(0.36, '#12295c');
  grad.addColorStop(0.50, '#0d1c3c');
  grad.addColorStop(0.62, '#16233f');
  grad.addColorStop(1.00, '#04060c');
  g.fillStyle = grad; g.fillRect(0, 0, 1024, 512);

  // key sun
  const sun = g.createRadialGradient(240, 130, 3, 240, 130, 190);
  sun.addColorStop(0, 'rgba(255,255,255,1)');
  sun.addColorStop(0.12, 'rgba(215,235,255,0.75)');
  sun.addColorStop(0.5, 'rgba(70,130,220,0.20)');
  sun.addColorStop(1, 'rgba(20,40,90,0)');
  g.fillStyle = sun; g.fillRect(0, 0, 1024, 512);

  // warm bounce
  const warm = g.createRadialGradient(800, 190, 3, 800, 190, 240);
  warm.addColorStop(0, 'rgba(255,150,70,0.55)');
  warm.addColorStop(1, 'rgba(20,30,60,0)');
  g.fillStyle = warm; g.fillRect(0, 0, 1024, 512);

  // stadium light banks
  for (let i = 0; i < 1024; i += 56) {
    g.fillStyle = (i % 112 === 0) ? 'rgba(190,225,255,0.85)' : 'rgba(255,190,130,0.7)';
    g.fillRect(i + 8, 252, 26, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromEquirectangular(makeEnvTexture());
  scene.environment = rt.texture;
  scene.environmentIntensity = 0.85;
  pmrem.dispose();
}

/* ---- sky dome ---- */
{
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x04070f) },
      mid: { value: new THREE.Color(0x10306a) },
      bot: { value: new THREE.Color(0x02040a) },
    },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: [
      'uniform vec3 top; uniform vec3 mid; uniform vec3 bot; varying vec3 vP;',
      'float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }',
      'void main(){',
      '  vec3 n = normalize(vP);',
      '  float y = n.y * 0.5 + 0.5;',
      '  vec3 c = mix(bot, mid, smoothstep(0.0, 0.5, y));',
      '  c = mix(c, top, smoothstep(0.5, 1.0, y));',
      '  vec2 g = floor(n.xz * 340.0 + n.y * 140.0);',
      '  float s = h(g);',
      '  if (s > 0.9972 && n.y > 0.05) c += vec3(0.75, 0.88, 1.0) * (s - 0.9972) * 340.0;',
      '  gl_FragColor = vec4(c, 1.0);',
      '}'
    ].join('\n')
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1900, 48, 28), skyMat));
}

/* ---- lights ---- */
scene.add(new THREE.HemisphereLight(0x86b6ff, 0x0a1020, 0.5));
const sun = new THREE.DirectionalLight(0xfff3e2, 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(1536, 1536);
sun.shadow.camera.left = -170; sun.shadow.camera.right = 170;
sun.shadow.camera.top = 170; sun.shadow.camera.bottom = -170;
sun.shadow.camera.near = 20; sun.shadow.camera.far = 900;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.25;
scene.add(sun);
scene.add(sun.target);

// two team-coloured rims only: every extra point light is another loop in the
// fragment shader of every lit material, which is expensive at full screen
const rimBlue = new THREE.PointLight(0x3a7cff, 4000, 620, 2); rimBlue.position.set(-240, 70, -330); scene.add(rimBlue);
const rimOrange = new THREE.PointLight(0xff6a28, 4000, 620, 2); rimOrange.position.set(240, 70, 330); scene.add(rimOrange);

/* ==========================================================================
   POST-PROCESSING: bloom + speed-scaled radial motion blur
   ========================================================================== */
let composer = null, bloomPass = null, blurPass = null, motionUniforms = null;
try {
  const [EC, RP, UB, OP, SP] = await Promise.all([
    import('https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js'),
    import('https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/RenderPass.js'),
    import('https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js'),
    import('https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/OutputPass.js'),
    import('https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/ShaderPass.js'),
  ]);

  composer = new EC.EffectComposer(renderer);
  composer.addPass(new RP.RenderPass(scene, camera));

  bloomPass = new UB.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.9, 0.78);
  composer.addPass(bloomPass);

  const MotionBlurShader = {
    uniforms: {
      tDiffuse: { value: null },
      uStrength: { value: 0.0 },
      uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uSamples: { value: 6 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse;',
      'uniform float uStrength;',
      'uniform vec2 uCenter;',
      'uniform int uSamples;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec2 dir = vUv - uCenter;',
      '  vec4 sum = vec4(0.0);',
      '  float total = 0.0;',
      '  for (int i = 0; i < 12; i++) {',
      '    if (i >= uSamples) break;',
      '    float t = (float(i) / float(uSamples - 1)) - 0.5;',
      '    float w = 1.0 - abs(t) * 1.1;',
      '    sum += texture2D(tDiffuse, vUv + dir * t * uStrength) * w;',
      '    total += w;',
      '  }',
      '  gl_FragColor = sum / max(total, 0.0001);',
      '}'
    ].join('\n')
  };
  blurPass = new SP.ShaderPass(MotionBlurShader);
  motionUniforms = blurPass.uniforms;
  composer.addPass(blurPass);

  composer.addPass(new OP.OutputPass());
} catch (e) {
  composer = null;
}

/* ==========================================================================
   ARENA GEOMETRY — a rounded box signed-distance field
   --------------------------------------------------------------------------
   sdf < 0 inside. The gradient is the surface normal, so the same function
   gives us collisions, the drive surface, and the visible shell.
   ========================================================================== */
const ARENA_CY = CFG.fieldY * 0.5;
const BX = CFG.fieldX - CFG.corner;
const BY = CFG.fieldY * 0.5 - CFG.corner;
const BZ = CFG.fieldZ - CFG.corner;

function arenaSDF(x, y, z, out) {
  const px = x, py = y - ARENA_CY, pz = z;
  const qx = Math.abs(px) - BX;
  const qy = Math.abs(py) - BY;
  const qz = Math.abs(pz) - BZ;
  const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
  const outer = Math.sqrt(mx * mx + my * my + mz * mz);
  const inner = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  if (out) {
    // gradient of the SDF points from the playable interior towards the wall,
    // so the *collision* normal (pointing back into the arena) is its negation
    if (outer > 1e-6) {
      out.set(-(px < 0 ? -mx : mx), -(py < 0 ? -my : my), -(pz < 0 ? -mz : mz)).multiplyScalar(1 / outer);
    } else {
      const m = Math.max(qx, Math.max(qy, qz));
      if (m === qx) out.set(px < 0 ? 1 : -1, 0, 0);
      else if (m === qy) out.set(0, py < 0 ? 1 : -1, 0);
      else out.set(0, 0, pz < 0 ? 1 : -1);
    }
  }
  return outer + inner - CFG.corner;
}

/* Worst (deepest) contact against the whole bowl, plus the goal tunnels.
   normals point INTO the arena; pen is how far past the surface we are. */
const _contact = { hit: false, pen: 0, nx: 0, ny: 0, nz: 0 };
const _nrm = new THREE.Vector3();
function pushContact(pen, nx, ny, nz) {
  if (pen > 0 && pen > _contact.pen) {
    _contact.pen = pen; _contact.nx = nx; _contact.ny = ny; _contact.nz = nz; _contact.hit = true;
  }
}
function arenaSurface(p, r) {
  _contact.hit = false; _contact.pen = -1e9;
  const ax = Math.abs(p.x), az = Math.abs(p.z);

  // inside a goal tunnel -> the goal box is the world (flat floor, no fillet)
  if (ax < CFG.goalHalfW - r * 0.4 && p.y < CFG.goalH - r * 0.4 && az > CFG.fieldZ - CFG.corner * 0.7) {
    const sgn = p.z < 0 ? -1 : 1;
    pushContact(r - p.y, 0, 1, 0);                                        // goal floor
    pushContact(p.y - (CFG.goalH - r), 0, -1, 0);                         // goal ceiling
    pushContact(r - (CFG.goalHalfW - ax), ax > 0 ? -1 : 1, 0, 0);         // goal side
    pushContact(r - ((CFG.fieldZ + CFG.goalDepth) - az), 0, 0, -sgn);     // goal back
    return _contact;
  }

  const d = arenaSDF(p.x, p.y, p.z, _nrm);
  // d < 0 inside the arena, so the sphere touches the wall when d === r
  if (d < r) pushContact(r + d, _nrm.x, _nrm.y, _nrm.z);
  return _contact;
}

/* ==========================================================================
   ARENA VISUALS
   ========================================================================== */
const arena = new THREE.Group();
scene.add(arena);

/* ---- shell: a box subdivided and projected onto the rounded surface ---- */
{
  const segX = 64, segY = 32, segZ = 64;
  const geo = new THREE.BoxGeometry(CFG.fieldX * 2, CFG.fieldY * 2, CFG.fieldZ * 2, segX, segY, segZ);
  geo.translate(0, ARENA_CY, 0);
  const pos = geo.attributes.position;
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    for (let k = 0; k < 4; k++) {
      const d = arenaSDF(p.x, p.y, p.z, n);
      p.addScaledVector(n, d);
    }
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  geo.computeVertexNormals();

  const shellMat = new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
    uniforms: {
      uCamera: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uFieldZ: { value: CFG.fieldZ },
      uFadeNear: { value: 260.0 },
      uFadeFar: { value: 1500.0 },
    },
    vertexShader: [
      'varying vec3 vW; varying vec3 vN;',
      'void main(){',
      '  vec4 w = modelMatrix * vec4(position, 1.0);',
      '  vW = w.xyz;',
      '  vN = normalize(mat3(modelMatrix) * normal);',
      '  gl_Position = projectionMatrix * viewMatrix * w;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uCamera; uniform float uTime; uniform float uFieldZ;',
      'uniform float uFadeNear; uniform float uFadeFar;',
      'varying vec3 vW; varying vec3 vN;',
      'float gridLine(vec3 p, float s, float w){',
      '  vec3 q = abs(fract(p * s) - 0.5);',
      '  float m = min(min(q.x, q.y), q.z);',
      '  return 1.0 - smoothstep(0.0, w, m);',
      '}',
      'void main(){',
      '  vec3 V = normalize(uCamera - vW);',
      '  vec3 N = normalize(vN);',
      '  float fres = pow(1.0 - abs(dot(V, N)), 2.6);',
      '  float dist = length(uCamera - vW);',
      '  float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);',
      '  float gFine = gridLine(vW, 0.02, 0.015);',
      '  float gCoarse = gridLine(vW, 0.1, 0.02);',
      '  float pulse = 0.85 + 0.15 * sin(uTime * 1.6 + vW.y * 0.03);',
      '  vec3 blue = vec3(0.22, 0.52, 1.0);',
      '  vec3 orange = vec3(1.0, 0.42, 0.14);',
      '  float t = clamp(vW.z / uFieldZ * 0.5 + 0.5, 0.0, 1.0);',
      '  vec3 tint = mix(blue, orange, t);',
      '  float low = exp(-max(vW.y, 0.0) * 0.035);',
      '  vec3 col = tint * (gFine * 0.30 + gCoarse * 0.55 + fres * 0.9 + low * 0.22) * pulse;',
      '  float alpha = (gFine * 0.16 + gCoarse * 0.26 + fres * 0.42 + low * 0.06) * fade;',
      '  gl_FragColor = vec4(col, alpha);',
      '}'
    ].join('\n'),
  });
  const shell = new THREE.Mesh(geo, shellMat);
  shell.frustumCulled = false;
  arena.add(shell);
  arena.userData.shell = shellMat;
}

/* ---- playing field ---- */
function makeFieldTexture() {
  const W = 1024, H = 1300;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');

  const base = g.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, '#070d1c'); base.addColorStop(0.5, '#0a1224'); base.addColorStop(1, '#070d1c');
  g.fillStyle = base; g.fillRect(0, 0, W, H);

  const washB = g.createLinearGradient(0, 0, 0, H * 0.4);
  washB.addColorStop(0, 'rgba(45,110,255,0.24)'); washB.addColorStop(1, 'rgba(45,110,255,0)');
  g.fillStyle = washB; g.fillRect(0, 0, W, H * 0.4);
  const washO = g.createLinearGradient(0, H, 0, H * 0.6);
  washO.addColorStop(0, 'rgba(255,110,40,0.24)'); washO.addColorStop(1, 'rgba(255,110,40,0)');
  g.fillStyle = washO; g.fillRect(0, H * 0.6, W, H * 0.4);

  g.strokeStyle = 'rgba(80,150,255,0.05)'; g.lineWidth = 1.5;
  for (let x = 0; x <= W; x += 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y <= H; y += 24) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }

  g.strokeStyle = 'rgba(90,165,255,0.05)'; g.lineWidth = 1.2;
  const s = 34;
  for (let y = -s; y < H + s; y += s * 0.87) {
    for (let x = -s; x < W + s; x += s * 1.5) {
      const ox = (Math.round(y / (s * 0.87)) % 2) ? s * 0.75 : 0;
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 3 * i;
        const px = x + ox + Math.cos(a) * s * 0.52, py = y + Math.sin(a) * s * 0.52;
        if (i) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.closePath(); g.stroke();
    }
  }

  const line = (fn, w, col) => {
    g.save();
    g.strokeStyle = col; g.lineWidth = w; g.shadowColor = col; g.shadowBlur = 26; g.globalAlpha = 0.92;
    fn(); g.stroke(); g.restore();
  };
  const CY = '#7fd4ff';
  const inset = 24;
  const fw = W - inset * 2, fh = H - inset * 2;
  line(() => g.strokeRect(inset, inset, fw, fh), 7, CY);
  line(() => { g.beginPath(); g.moveTo(inset, H / 2); g.lineTo(W - inset, H / 2); }, 7, CY);
  line(() => { g.beginPath(); g.arc(W / 2, H / 2, 150, 0, Math.PI * 2); }, 7, CY);
  line(() => { g.beginPath(); g.arc(W / 2, H / 2, 14, 0, Math.PI * 2); }, 9, CY);

  const bw = fw * 0.62, bh = fh * 0.155;
  line(() => g.strokeRect(W / 2 - bw / 2, inset, bw, bh), 6, CY);
  line(() => g.strokeRect(W / 2 - bw / 2, H - inset - bh, bw, bh), 6, CY);
  line(() => { g.beginPath(); g.arc(W / 2, inset + bh * 0.55, bw * 0.24, 0, Math.PI); }, 5, CY);
  line(() => { g.beginPath(); g.arc(W / 2, H - inset - bh * 0.55, bw * 0.24, Math.PI, Math.PI * 2); }, 5, CY);
  for (const sx of [0, 1]) for (const sy of [0, 1]) {
    const cx = sx ? W - inset : inset, cy = sy ? H - inset : inset;
    const a0 = sx ? (sy ? Math.PI : Math.PI / 2) : (sy ? Math.PI * 1.5 : 0);
    line(() => { g.beginPath(); g.arc(cx, cy, 62, a0, a0 + Math.PI / 2); }, 5, CY);
  }
  g.save(); g.globalAlpha = 0.55;
  g.fillStyle = 'rgba(70,160,255,0.7)'; g.fillRect(W / 2 - bw / 2, inset - 4, bw, 5);
  g.fillStyle = 'rgba(255,110,40,0.7)'; g.fillRect(W / 2 - bw / 2, H - inset - 1, bw, 5);
  g.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const FLOOR_HX = CFG.fieldX - CFG.corner;
const FLOOR_HZ = CFG.fieldZ - CFG.corner;
{
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(FLOOR_HX * 2, FLOOR_HZ * 2, 48, 60),
    new THREE.MeshStandardMaterial({
      map: makeFieldTexture(), roughness: 0.55, metalness: 0.4,
      color: 0xd8e8ff, envMapIntensity: 1.2,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  arena.add(floor);
}

/* ---- goals ---- */
function makeNetTexture(color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.strokeStyle = color; g.lineWidth = 2.2; g.globalAlpha = 0.85;
  for (let i = -256; i <= 512; i += 20) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 256, 256); g.stroke();
    g.beginPath(); g.moveTo(i, 256); g.lineTo(i + 256, 0); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(5, 3);
  return t;
}

const goalData = [];
const WHITE = new THREE.Color(0xffffff);
function buildGoal(sign, colorHex, colorCss) {
  const g = new THREE.Group();
  const W = CFG.goalHalfW, H = CFG.goalH, D = CFG.goalDepth, z = sign * CFG.fieldZ;

  const frameMat = new THREE.MeshPhysicalMaterial({
    color: colorHex, emissive: colorHex, emissiveIntensity: 1.1,
    roughness: 0.25, metalness: 0.9, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 1.5,
  });
  const postGeo = new THREE.CylinderGeometry(1.5, 1.5, H, 20);
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(postGeo, frameMat);
    p.position.set(sx * W, H / 2, z); p.castShadow = true; g.add(p);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1.7, 16, 12), frameMat);
    cap.position.set(sx * W, H, z); g.add(cap);
  }
  const cross = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, W * 2, 20), frameMat);
  cross.rotation.z = Math.PI / 2; cross.position.set(0, H, z); cross.castShadow = true; g.add(cross);

  const netMat = new THREE.MeshBasicMaterial({
    map: makeNetTexture(colorCss), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.4, fog: false,
  });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, H), netMat);
  back.position.set(0, H / 2, z + sign * D); g.add(back);
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(D, H), netMat);
    side.rotation.y = Math.PI / 2; side.position.set(sx * W, H / 2, z + sign * D / 2); g.add(side);
  }
  const top = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, D), netMat);
  top.rotation.x = Math.PI / 2; top.position.set(0, H, z + sign * D / 2); g.add(top);

  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 2, 2.4),
    new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.95, fog: false })
  );
  strip.rotation.x = -Math.PI / 2; strip.position.set(0, 0.12, z - sign * 1.2);
  g.add(strip);

  arena.add(g);
  goalData.push({ sign, group: g, colorHex, strip, flash: 0 });
  return g;
}
buildGoal(1, 0xff5a2a, '#ff8a4a');
buildGoal(-1, 0x2a7cff, '#4aa8ff');

/* ---- distant stadium ---- */
{
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x0a1a38, transparent: true, opacity: 0.7, side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(900, 900, 190, 72, 1, true), ringMat);
  ring.position.y = 70;
  scene.add(ring);
  // one instanced mesh instead of 64 separate draw calls
  const lightGeo = new THREE.BoxGeometry(22, 4, 4);
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  const N = 64;
  const lights = new THREE.InstancedMesh(lightGeo, lightMat, N);
  const dummy = new THREE.Object3D();
  const cA = new THREE.Color(0x7cc0ff), cB = new THREE.Color(0xffc07a);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    dummy.position.set(Math.cos(a) * 886, 150 + Math.sin(i * 2.3) * 8, Math.sin(a) * 886);
    dummy.lookAt(0, 60, 0);
    dummy.updateMatrix();
    lights.setMatrixAt(i, dummy.matrix);
    lights.setColorAt(i, (i % 2) ? cA : cB);
  }
  lights.instanceMatrix.needsUpdate = true;
  if (lights.instanceColor) lights.instanceColor.needsUpdate = true;
  lights.frustumCulled = false;
  scene.add(lights);
}

/* ==========================================================================
   PARTICLES
   ========================================================================== */
const _pc = new THREE.Color();
class Particles {
  constructor(count, additive) {
    const geo = new THREE.SphereGeometry(1, 7, 5);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, fog: false,
      blending: additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.count = count; this.head = 0;
    this.life = new Float32Array(count);
    this.max = new Float32Array(count);
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.grav = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      this.dummy.position.set(0, -99999, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, _pc.setHex(0xffffff));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  spawn(x, y, z, vx, vy, vz, size, life, color, grav, drag) {
    const i = this.head; this.head = (this.head + 1) % this.count;
    const k = i * 3;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
    this.size[i] = size; this.life[i] = life; this.max[i] = life;
    this.grav[i] = grav === undefined ? -14 : grav;
    this.drag[i] = drag === undefined ? 0.965 : drag;
    this.mesh.setColorAt(i, _pc.setHex(color === undefined ? 0xffffff : color));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  update(dt) {
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      dirty = true;
      this.life[i] -= dt;
      const k = i * 3;
      const d = Math.pow(this.drag[i], dt * 60);
      this.vel[k] *= d;
      this.vel[k + 1] = this.vel[k + 1] * d + this.grav[i] * dt;
      this.vel[k + 2] *= d;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.life[i] <= 0) {
        this.dummy.position.set(0, -99999, 0); this.dummy.scale.setScalar(0.0001);
      } else {
        const t = Math.max(0, this.life[i] / this.max[i]);
        this.dummy.position.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
        this.dummy.scale.setScalar(this.size[i] * (0.25 + t * 0.75));
      }
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
const sparks = new Particles(300);
const boostFx = new Particles(460);
const trailFx = new Particles(200);
const dustFx = new Particles(160, false);

/* ==========================================================================
   BALL
   ========================================================================== */
function makeBallTexture() {
  const W = 1536, H = 768;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#f2f6ff'; g.fillRect(0, 0, W, H);

  const st = g.createLinearGradient(0, 0, W, 0);
  st.addColorStop(0.00, 'rgba(60,140,255,0.35)');
  st.addColorStop(0.26, 'rgba(60,140,255,0)');
  st.addColorStop(0.74, 'rgba(255,110,40,0)');
  st.addColorStop(1.00, 'rgba(255,110,40,0.35)');
  g.fillStyle = st; g.fillRect(0, 0, W, H);

  const R = 66;
  const pent = (cx, cy, rot, rad) => {
    g.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = rot + i * Math.PI * 2 / 5;
      const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.closePath();
    g.fillStyle = '#101725'; g.fill();
    g.strokeStyle = '#33405c'; g.lineWidth = 4; g.stroke();
  };
  const seam = (cx, cy, rad) => {
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.closePath();
    g.strokeStyle = 'rgba(45,60,90,0.5)'; g.lineWidth = 5; g.stroke();
  };
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 14; col++) {
      const x = col * (R * 1.6) + (row % 2 ? R * 0.8 : 0) - 30;
      const y = row * (R * 1.4) + 34;
      seam(x, y, R * 0.98);
      if ((row + col) % 2 === 0) pent(x, y, row * 0.4, R * 0.55);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const ball = {
  pos: new THREE.Vector3(0, CFG.ballR, 0),
  vel: new THREE.Vector3(),
  spin: new THREE.Vector3(),
  r: CFG.ballR,
  speed: 0,
  mesh: null,
  glow: null,
};
{
  const g = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(CFG.ballR, 56, 36),
    new THREE.MeshPhysicalMaterial({
      map: makeBallTexture(), roughness: 0.38, metalness: 0.25,
      clearcoat: 0.6, clearcoatRoughness: 0.25,
      emissive: 0x1a3f88, emissiveIntensity: 0.2, envMapIntensity: 1.3,
    })
  );
  core.castShadow = true;
  g.add(core);
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(CFG.ballR * 1.4, 24, 18),
    new THREE.MeshBasicMaterial({ color: 0x5ab4ff, transparent: true, opacity: 0.09, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
  );
  g.add(glow);
  scene.add(g);
  ball.mesh = g;
  ball.glow = glow;
}

/* ==========================================================================
   CAR MESH  —  extruded side silhouette + detailed running gear
   ========================================================================== */
function buildCarMesh(team) {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = -CFG.carRide;
  g.add(inner);

  const primary = team === 0 ? 0x1f6cff : 0xff2f3e;
  const accent = team === 0 ? 0x9fe0ff : 0xffc0c4;

  const paint = new THREE.MeshPhysicalMaterial({
    color: primary, roughness: 0.16, metalness: 0.6,
    clearcoat: 1.0, clearcoatRoughness: 0.05, envMapIntensity: 2.0,
    emissive: primary, emissiveIntensity: 0.05,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0a0f18, roughness: 0.55, metalness: 0.7, envMapIntensity: 1.0 });
  // NOTE: no `transmission` here on purpose. Any transmission > 0 makes three.js
  // re-render the whole scene into a transmission target every frame, which was
  // the single biggest cause of the frame drops.
  const glass = new THREE.MeshStandardMaterial({
    color: 0x1e4a80, roughness: 0.06, metalness: 0.95,
    transparent: true, opacity: 0.55, envMapIntensity: 2.6,
    emissive: 0x0e2c52, emissiveIntensity: 0.5,
  });
  const trim = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.9, roughness: 0.28, metalness: 0.7 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0c0f16, roughness: 0.94, metalness: 0.04 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xcfd8e6, roughness: 0.14, metalness: 1.0, envMapIntensity: 2.2 });
  const lampW = new THREE.MeshBasicMaterial({ color: 0xfff7d2, fog: false });
  const lampR = new THREE.MeshBasicMaterial({ color: 0xff2a12, fog: false });

  /* ---------- body: refined silhouette extruded across the width ---------- */
  const pts = [
    [-4.35, 0.62], [-2.20, 0.50], [2.40, 0.50], [3.84, 0.64],
    [4.46, 1.22], [4.18, 1.72], [3.10, 2.02], [1.90, 2.14],
    [1.10, 2.44], [0.42, 2.94], [-1.25, 3.06], [-2.35, 2.94],
    [-3.20, 2.42], [-4.05, 1.86], [-4.42, 1.28],
  ];
  const profile = new THREE.Shape();
  profile.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) profile.lineTo(pts[i][0], pts[i][1]);
  profile.closePath();

  const bodyGeo = new THREE.ExtrudeGeometry(profile, {
    depth: 4.5, bevelEnabled: true, bevelSize: 0.62, bevelThickness: 0.62,
    bevelSegments: 6, curveSegments: 4,
  });
  bodyGeo.translate(0, 0, -2.25);
  bodyGeo.rotateY(-Math.PI / 2);
  bodyGeo.computeVertexNormals();
  const body = new THREE.Mesh(bodyGeo, paint);
  body.castShadow = true; body.receiveShadow = true;
  inner.add(body);

  /* ---------- canopy ---------- */
  const cpts = [
    [1.16, 2.40], [0.44, 2.92], [-1.24, 3.04], [-2.30, 2.92],
    [-2.30, 2.30], [1.02, 2.24],
  ];
  const cab = new THREE.Shape();
  cab.moveTo(cpts[0][0], cpts[0][1]);
  for (let i = 1; i < cpts.length; i++) cab.lineTo(cpts[i][0], cpts[i][1]);
  cab.closePath();
  const cabGeo = new THREE.ExtrudeGeometry(cab, { depth: 3.5, bevelEnabled: true, bevelSize: 0.3, bevelThickness: 0.22, bevelSegments: 3 });
  cabGeo.translate(0, 0, -1.75);
  cabGeo.rotateY(-Math.PI / 2);
  const canopy = new THREE.Mesh(cabGeo, glass);
  inner.add(canopy);

  /* ---------- cockpit interior, visible through the glass ---------- */
  const dash = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.26, 0.5), dark);
  dash.position.set(0, 2.32, 1.02); inner.add(dash);
  const seatBase = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 1.0), dark);
  seatBase.position.set(0, 2.30, -0.35); inner.add(seatBase);
  const seatBack = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.0, 0.2), dark);
  seatBack.position.set(0, 2.78, -0.86); seatBack.rotation.x = 0.18; inner.add(seatBack);
  const sWheel = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.06, 8, 16), dark);
  sWheel.position.set(0, 2.62, 0.62); sWheel.rotation.x = -0.5; inner.add(sWheel);
  for (const sx of [-1, 1]) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 8), chrome);
    bar.position.set(sx * 0.95, 2.70, -1.00); bar.rotation.z = 0.32; inner.add(bar);
  }

  /* ---------- wheel arches ---------- */
  const archGeo = new THREE.TorusGeometry(1.46, 0.26, 8, 14, Math.PI);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const arch = new THREE.Mesh(archGeo, paint);
    arch.position.set(sx * 2.62, 1.08, sz * 2.9);
    arch.rotation.y = Math.PI / 2;
    inner.add(arch);
  }

  /* ---------- hood vents, splitter, diffuser ---------- */
  for (const sx of [-0.9, -0.3, 0.3, 0.9]) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.1, 0.8), dark);
    vent.position.set(sx, 2.06, 2.35); inner.add(vent);
  }
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.16, 1.1), dark);
  splitter.position.set(0, 0.42, 3.95); inner.add(splitter);
  for (const sx of [-1, 1]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.55, 1.1), trim);
    ep.position.set(sx * 2.66, 0.62, 3.95); inner.add(ep);
  }
  const diff = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.5, 0.5), dark);
  diff.position.set(0, 0.56, -4.28); inner.add(diff);
  for (let i = -2; i <= 2; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.85), dark);
    fin.position.set(i * 1.0, 0.62, -3.95); inner.add(fin);
  }

  /* ---------- mirrors ---------- */
  for (const sx of [-1, 1]) {
    const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.08), dark);
    stalk.position.set(sx * 2.72, 2.22, 1.42); inner.add(stalk);
    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 0.42), trim);
    mir.position.set(sx * 2.98, 2.28, 1.34); inner.add(mir);
  }

  /* ---------- skirts + racing stripes ---------- */
  for (const sx of [-1, 1]) {
    const sk = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.5, 5.4), trim);
    sk.position.set(sx * 2.86, 0.78, -0.2); inner.add(sk);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 6.6), trim);
    stripe.position.set(sx * 1.05, 2.16, 0.1); inner.add(stripe);
  }

  /* ---------- lights ---------- */
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.30, 0.18), lampW);
    hl.position.set(sx * 1.5, 1.50, 4.36); inner.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.24, 0.14), lampR);
    tl.position.set(sx * 1.35, 1.62, -4.42); inner.add(tl);
  }

  /* ---------- rear wing: extruded airfoil ---------- */
  const foil = new THREE.Shape();
  foil.moveTo(-0.62, 0.0);
  foil.quadraticCurveTo(0.0, 0.42, 0.66, 0.08);
  foil.quadraticCurveTo(0.0, -0.14, -0.62, 0.0);
  const wingGeo = new THREE.ExtrudeGeometry(foil, { depth: 4.6, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08, bevelSegments: 2 });
  wingGeo.rotateY(Math.PI / 2);
  wingGeo.translate(-2.3, 0, 0);
  const wing = new THREE.Mesh(wingGeo, trim);
  wing.position.set(0, 3.14, -3.35); wing.castShadow = true;
  inner.add(wing);
  for (const sx of [-1, 1]) {
    const sup = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.05, 0.75), dark);
    sup.position.set(sx * 1.55, 2.66, -3.30); inner.add(sup);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.72, 1.3), trim);
    plate.position.set(sx * 2.30, 3.14, -3.35); inner.add(plate);
  }

  /* ---------- wheels ---------- */
  const tyreGeo = new THREE.CylinderGeometry(1.08, 1.08, 0.9, 28);
  tyreGeo.rotateZ(Math.PI / 2);
  const sideGeo = new THREE.TorusGeometry(0.95, 0.11, 6, 22);
  sideGeo.rotateY(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.68, 0.68, 0.94, 20);
  rimGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 1.0, 10);
  hubGeo.rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.96, 0.13, 1.16);
  const discGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.1, 18);
  discGeo.rotateZ(Math.PI / 2);
  const calGeo = new THREE.BoxGeometry(0.16, 0.34, 0.2);
  const wheels = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const holder = new THREE.Group();
    holder.position.set(sx * 2.72, 1.08, sz * 2.9);
    // everything that rolls lives under this group so the spokes keep their
    // radial layout while the wheel spins
    const spin = new THREE.Group();
    holder.add(spin);
    const t = new THREE.Mesh(tyreGeo, rubber); t.castShadow = true; spin.add(t);
    for (const o of [-0.36, 0.36]) {
      const sw = new THREE.Mesh(sideGeo, rubber);
      sw.position.x = o; spin.add(sw);
    }
    spin.add(new THREE.Mesh(rimGeo, trim));
    spin.add(new THREE.Mesh(hubGeo, chrome));
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.Mesh(spokeGeo, dark);
      sp.rotation.x = (i / 5) * Math.PI * 2;
      spin.add(sp);
    }
    holder.add(new THREE.Mesh(discGeo, chrome));
    const cal = new THREE.Mesh(calGeo, trim);
    cal.position.set(sx * 0.18, 0.28, 0.35); holder.add(cal);
    inner.add(holder);
    wheels.push({ holder, spin, front: sz > 0 });
  }

  /* ---------- boost nozzles ---------- */
  for (const sx of [-1, 1]) {
    const noz = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.8, 14), dark);
    noz.rotation.x = Math.PI / 2;
    noz.position.set(sx * 1.25, 0.95, -4.55);
    inner.add(noz);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.1, 8, 16), trim);
    ring.position.set(sx * 1.25, 0.95, -4.9);
    inner.add(ring);
  }

  /* ---------- gun ---------- */
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.32, 2.3, 14), dark);
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.72, 5.0); inner.add(barrel);
  const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.11, 8, 18), trim);
  muzzle.position.set(0, 0.72, 6.15); inner.add(muzzle);

  /* ---------- underglow ---------- */
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(6.6, 10.4),
    new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
  );
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.12; inner.add(glow);

  /* ---------- boost flames ---------- */
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(1.05, 7.0, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x8fe8ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })
  );
  flame.rotation.x = Math.PI / 2; flame.position.set(0, 1.0, -8.0);
  flame.visible = false; inner.add(flame);
  const flameCore = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 4.6, 14, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })
  );
  flameCore.rotation.x = Math.PI / 2; flameCore.position.set(0, 1.0, -6.4);
  flameCore.visible = false; inner.add(flameCore);

  /* ---------- hit shield ---------- */
  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(6.2, 24, 18),
    new THREE.MeshBasicMaterial({ color: 0x8fe4ff, transparent: true, opacity: 0, wireframe: true, depthWrite: false, fog: false })
  );
  shield.position.y = 1.2; inner.add(shield);

  g.userData = { wheels, flame, flameCore, shield, muzzle, paint, trim, glow, inner };
  return g;
}

class Car {
  constructor(team, isPlayer, name) {
    this.team = team; this.isPlayer = isPlayer; this.name = name;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.av = new THREE.Vector3();
    this.yaw = 0;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.onSurface = true;
    this.onWall = false; this.onCeiling = false;
    this.boost = 34; this.boosting = false; this.supersonic = false;
    this.canFlip = true; this.flipTimer = 0; this.airTime = 0;
    this.ammo = CFG.magSize; this.reload = 0; this.gunCd = 0;
    this.stun = 0; this.hitFlash = 0; this.wheelSpin = 0; this.steerVis = 0;
    this.dip = 0;
    this.jumpLock = 0;
    this.demolished = false; this.respawn = 0;
    this.input = { throttle: 0, steer: 0, boost: false, jump: false, jumpPressed: false, roll: 0, drift: false, shoot: false };
    this.prevJump = false;
    this.mesh = buildCarMesh(team);
    scene.add(this.mesh);
    this.spawnPos = new THREE.Vector3(); this.spawnYaw = 0;
  }
  reset() {
    this.pos.copy(this.spawnPos); this.yaw = this.spawnYaw;
    this.vel.set(0, 0, 0); this.av.set(0, 0, 0);
    this.q.setFromEuler(new THREE.Euler(0, this.yaw, 0));
    this.groundNormal.set(0, 1, 0);
    this.onSurface = true; this.onWall = false; this.onCeiling = false;
    this.canFlip = true; this.flipTimer = 0; this.airTime = 0;
    this.stun = 0; this.hitFlash = 0; this.demolished = false; this.respawn = 0;
    this.dip = 0; this.jumpLock = 0;
    this.boost = 34; this.ammo = CFG.magSize; this.reload = 0; this.gunCd = 0;
    const i = this.input;
    i.throttle = 0; i.steer = 0; i.boost = false; i.shoot = false; i.jumpPressed = false; i.drift = false; i.roll = 0;
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.q);
    this.mesh.visible = true;
  }
  // These hand back shared scratch vectors: the hot loop calls them thousands of
  // times a second and allocating a Vector3 each time was pure GC pressure.
  // Each axis has its own scratch so callers can safely hold all three at once.
  forwardVec() { return _fwd.set(0, 0, 1).applyQuaternion(this.q); }
  rightVec() { return _rgt.set(1, 0, 0).applyQuaternion(this.q); }
  upVec() { return _up.set(0, 1, 0).applyQuaternion(this.q); }
}
const _fwd = new THREE.Vector3(), _rgt = new THREE.Vector3(), _up = new THREE.Vector3();

const player = new Car(0, true, 'YOU');
const cpu = new Car(1, false, 'CPU');

/* ==========================================================================
   BULLETS
   ========================================================================== */
const bullets = [];
const bulletGeo = new THREE.SphereGeometry(CFG.bulletR, 12, 10);
const bulletMatP = new THREE.MeshBasicMaterial({ color: 0xfff0a0, fog: false });
const bulletMatE = new THREE.MeshBasicMaterial({ color: 0xff9a9a, fog: false });

function fire(car) {
  if (car.demolished || car.reload > 0 || car.gunCd > 0 || car.stun > 0) return;
  if (car.ammo <= 0) { car.reload = CFG.reloadTime; return; }
  car.ammo--; car.gunCd = CFG.gunCooldown;

  const fwd = car.forwardVec();
  const origin = car.pos.clone().addScaledVector(fwd, 7.5).add(new THREE.Vector3(0, 0.7, 0));
  const dir = fwd.clone().normalize();

  const toBall = ball.pos.clone().sub(origin);
  const dist = toBall.length();
  if (dist > 1) {
    toBall.add(ball.vel.clone().multiplyScalar(dist / CFG.bulletSpeed));
    toBall.normalize();
    dir.lerp(toBall, 0.45).normalize();
  }

  const b = {
    pos: origin, vel: dir.multiplyScalar(CFG.bulletSpeed),
    life: CFG.bulletLife, owner: car,
    mesh: new THREE.Mesh(bulletGeo, car.team === 0 ? bulletMatP : bulletMatE),
  };
  b.mesh.position.copy(origin);
  scene.add(b.mesh);
  bullets.push(b);

  for (let i = 0; i < 10; i++)
    sparks.spawn(origin.x, origin.y, origin.z,
      (Math.random() - 0.5) * 26, (Math.random() - 0.5) * 26, (Math.random() - 0.5) * 26, 0.55, 0.18, 0xffe08a);
  if (car.isPlayer) Sound.shoot();
  if (car.ammo <= 0) car.reload = CFG.reloadTime;
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    b.pos.addScaledVector(b.vel, dt);
    b.mesh.position.copy(b.pos);
    if (Math.random() < 0.9) boostFx.spawn(b.pos.x, b.pos.y, b.pos.z, 0, 0, 0, 0.4, 0.18, 0x8fe8ff, 0, 0.9);

    let dead = b.life <= 0;

    if (!dead && b.pos.distanceTo(ball.pos) < CFG.ballR + CFG.bulletR) {
      const n = ball.pos.clone().sub(b.pos).normalize();
      ball.vel.addScaledVector(n, CFG.bulletImpulse);
      ball.vel.y += 14;
      ball.spin.add(new THREE.Vector3((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18));
      for (let k = 0; k < 22; k++)
        sparks.spawn(ball.pos.x, ball.pos.y, ball.pos.z,
          (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50, 0.7, 0.4, 0xffc76a);
      Sound.hit();
      if (b.owner.isPlayer) flashHitmarker();
      dead = true;
    }

    if (!dead) {
      const target = b.owner.team === 0 ? cpu : player;
      if (!target.demolished && b.pos.distanceTo(target.pos) < CFG.carR + CFG.bulletR) {
        const dir = target.pos.clone().sub(b.owner.pos).setY(0).normalize();
        target.vel.addScaledVector(dir, CFG.carBulletImpulse);
        target.vel.y += 16;
        target.stun = 0.3;
        target.boost = Math.max(0, target.boost - 26);
        target.hitFlash = 1;
        target.av.add(new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14));
        for (let k = 0; k < 24; k++)
          sparks.spawn(target.pos.x, target.pos.y, target.pos.z,
            (Math.random() - 0.5) * 55, (Math.random() - 0.5) * 55, (Math.random() - 0.5) * 55, 0.75, 0.45, 0xff9a5a);
        if (b.owner.isPlayer) flashHitmarker(); else damageFlash();
        Sound.hit();
        dead = true;
      }
    }

    if (!dead) {
      const p = b.pos;
      if (Math.abs(p.x) > CFG.fieldX + 4 || p.y > CFG.fieldY || p.y < 0 || Math.abs(p.z) > CFG.fieldZ + CFG.goalDepth) dead = true;
    }

    if (dead) { scene.remove(b.mesh); bullets.splice(i, 1); }
  }
}

/* ==========================================================================
   BOOST PADS  (RL layout, scaled to the big arena)
   ========================================================================== */
const pads = [];
const padGeoBig = new THREE.CylinderGeometry(12, 12, 0.9, 30);
const padGeoSmall = new THREE.CylinderGeometry(5.6, 5.6, 0.8, 22);
function addPad(x, z, big) {
  const mat = new THREE.MeshStandardMaterial({
    color: big ? 0xffc400 : 0xffe066, emissive: big ? 0xffa000 : 0xffcc33,
    emissiveIntensity: 2.0, transparent: true, opacity: 0.94, roughness: 0.3, metalness: 0.4, fog: false,
  });
  const m = new THREE.Mesh(big ? padGeoBig : padGeoSmall, mat);
  m.position.set(x, 0.5, z);
  scene.add(m);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(big ? 13.4 : 6.6, 0.5, 8, 34),
    new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.7, fog: false })
  );
  ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.7, z); scene.add(ring);
  const halo = new THREE.Mesh(
    new THREE.CylinderGeometry(big ? 12 : 5.6, big ? 12 : 5.6, big ? 55 : 26, 22, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffb300, transparent: true, opacity: 0.09, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
  );
  halo.position.set(x, big ? 28 : 14, z); scene.add(halo);
  pads.push({ x, z, big, mesh: m, ring, halo, cd: 0, amount: big ? 100 : 12, maxCd: big ? 10 : 4, baseY: m.position.y, rad: big ? 15 : 8 });
}
const BIGP = [[-245, -305], [245, -305], [-245, 305], [245, 305], [-245, 0], [245, 0]];
for (const p of BIGP) addPad(p[0], p[1], true);
const SMALLP = [
  [-80, -240], [80, -240], [-80, 240], [80, 240],
  [-185, -120], [185, -120], [-185, 120], [185, 120],
  [-185, 0], [185, 0], [0, -290], [0, 290],
];
for (const p of SMALLP) addPad(p[0], p[1], false);

function updatePads(dt, car, tick) {
  for (const p of pads) {
    if (p.cd > 0) {
      if (tick) p.cd -= dt;
      p.mesh.visible = false; p.ring.visible = false; p.halo.visible = false;
      continue;
    }
    p.mesh.visible = true; p.ring.visible = true; p.halo.visible = true;
    p.mesh.scale.setScalar(1);
    p.mesh.position.y = p.baseY + Math.sin(performance.now() * 0.003 + p.x) * 0.4;
    const dx = car.pos.x - p.x, dz = car.pos.z - p.z;
    if (dx * dx + dz * dz < p.rad * p.rad && Math.abs(car.pos.y - CFG.carRide) < 14) {
      if (car.boost < CFG.boostMax - 1) {
        car.boost = Math.min(CFG.boostMax, car.boost + p.amount);
        p.cd = p.maxCd;
        p.mesh.visible = false; p.ring.visible = false; p.halo.visible = false;
        for (let i = 0; i < (p.big ? 34 : 14); i++)
          boostFx.spawn(p.x, 2.5, p.z,
            (Math.random() - 0.5) * 46, Math.random() * 42, (Math.random() - 0.5) * 46,
            p.big ? 1.0 : 0.7, 0.6, 0xffc400);
        if (car.isPlayer) { if (p.big) Sound.bigPad(); else Sound.pad(); }
      }
    }
  }
}

/* ==========================================================================
   CAR PHYSICS
   --------------------------------------------------------------------------
   Surface contact comes from sampling the car hull against the arena SDF, so
   the car rides the floor->wall fillet smoothly and can drive on any surface.
   ========================================================================== */
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3();
const _vG = new THREE.Vector3(), _vUp = new THREE.Vector3();
const _lx = new THREE.Vector3(), _ly = new THREE.Vector3(), _lz = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e1 = new THREE.Euler();

const CAR_SKIN = 0.45;
const _carSamples = [];
{
  const h = CFG.carHalf;
  const xs = [-h.x * 0.84, 0, h.x * 0.84];
  const ys = [-h.y, h.y];
  const zs = [-h.z * 0.9, 0, h.z * 0.9];
  for (const x of xs) for (const y of ys) for (const z of zs) _carSamples.push(new THREE.Vector3(x, y, z));
}

const _cs = { hit: false, pen: 0, nx: 0, ny: 0, nz: 0 };
function carSurface(car) {
  _cs.hit = false; _cs.pen = 0;
  _vUp.set(0, 1, 0).applyQuaternion(car.q);
  const cx = car.pos.x + _vUp.x * CFG.carOffsetY;
  const cy = car.pos.y + _vUp.y * CFG.carOffsetY;
  const cz = car.pos.z + _vUp.z * CFG.carOffsetY;
  for (let i = 0; i < _carSamples.length; i++) {
    const s = _carSamples[i];
    _v6.copy(s).applyQuaternion(car.q);
    _v6.x += cx; _v6.y += cy; _v6.z += cz;
    const ct = arenaSurface(_v6, CAR_SKIN);
    if (ct.hit && ct.pen > _cs.pen) {
      _cs.pen = ct.pen; _cs.nx = ct.nx; _cs.ny = ct.ny; _cs.nz = ct.nz; _cs.hit = true;
    }
  }
  return _cs;
}

function spawnFlames(car) {
  if (Math.random() > 0.6) return;
  const back = car.pos.clone().addScaledVector(car.forwardVec(), -7.5);
  back.addScaledVector(car.rightVec(), (Math.random() - 0.5) * 2.6);
  const v = car.forwardVec().multiplyScalar(-42 - Math.random() * 26);
  v.add(new THREE.Vector3((Math.random() - 0.5) * 11, (Math.random() - 0.5) * 11, (Math.random() - 0.5) * 11));
  boostFx.spawn(back.x, back.y + 0.8, back.z, v.x, v.y, v.z,
    1.0 + Math.random() * 0.8, 0.32 + Math.random() * 0.22, car.supersonic ? 0xfff0a0 : 0x8fe8ff, 10, 0.93);
  if (car.isPlayer && Math.random() < 0.1) Sound.boost();
}

function doFlip(car, inp) {
  const up = car.upVec();
  const f = car.forwardVec();
  const r = car.rightVec();
  const dir = new THREE.Vector3();
  if (inp.throttle > 0) dir.add(f);
  else if (inp.throttle < 0) dir.sub(f);
  if (inp.steer < 0) dir.add(r);
  else if (inp.steer > 0) dir.sub(r);
  if (dir.lengthSq() < 0.02) dir.copy(f);
  dir.normalize();

  car.vel.addScaledVector(dir, CFG.flipSpeed);
  car.vel.y += 9;

  const axis = _v4.copy(up).cross(dir);
  if (axis.lengthSq() < 1e-4) axis.set(1, 0, 0);
  axis.normalize();
  car.av.multiplyScalar(0.1);
  car.av.addScaledVector(axis, CFG.flipSpin);
  car.flipTimer = 0.45;
  car.canFlip = false;
  car.jumpLock = 0.16;

  for (let i = 0; i < 26; i++)
    boostFx.spawn(car.pos.x, car.pos.y, car.pos.z,
      (Math.random() - 0.5) * 44, (Math.random() - 0.5) * 44, (Math.random() - 0.5) * 44, 0.7, 0.32, 0xcfeaff);
  Sound.flip();
}

function stepCar(car, dt) {
  const inp = car.input;

  if (car.demolished) {
    car.respawn -= dt;
    if (car.respawn <= 0) {
      car.demolished = false;
      car.mesh.visible = true;
      car.reset();
      for (let i = 0; i < 40; i++)
        boostFx.spawn(car.pos.x, car.pos.y, car.pos.z,
          (Math.random() - 0.5) * 50, Math.random() * 46, (Math.random() - 0.5) * 50, 0.9, 0.6, 0x9fe8ff);
    }
    return;
  }

  if (car.stun > 0) { inp.throttle = 0; inp.steer = 0; inp.boost = false; inp.drift = false; }
  if (car.jumpLock > 0) car.jumpLock -= dt;

  const up = car.groundNormal;
  const f0 = car.forwardVec();
  const forward = _v1.copy(f0).addScaledVector(up, -f0.dot(up));
  if (forward.lengthSq() < 1e-4) forward.copy(_v2.set(1, 0, 0).applyQuaternion(car.q));
  forward.normalize();
  const right = _v2.copy(up).cross(forward).normalize();

  car.boosting = false;

  if (car.onSurface) {
    car.canFlip = true;
    car.airTime = 0;

    car.vel.addScaledVector(forward, inp.throttle * CFG.carAccel * dt);

    if (inp.boost && car.boost > 0) {
      car.boosting = true;
      // boost always pushes along the nose, not along the surface, so
      // pointing up and boosting lifts you off the ground like in RL
      car.vel.addScaledVector(car.forwardVec(), CFG.boostAccel * dt);
      car.boost = Math.max(0, car.boost - CFG.boostUse * dt);
      spawnFlames(car);
    }

    // gravity projected onto the surface
    _vG.set(0, -CFG.gravity, 0).addScaledVector(up, CFG.gravity * up.y);
    car.vel.addScaledVector(_vG, dt);

    /* ---- tyre model ------------------------------------------------------
       Front and rear axles resist sideways motion by different amounts. The
       rear lets go first, which yaws the car into the corner and lets you
       break traction into a drift instead of feeling like it is on rails. */
    const vLat = right.dot(car.vel);
    const frontGrip = inp.drift ? CFG.carDriftGrip * 1.35 : CFG.carGripFront;
    const rearGrip = inp.drift ? CFG.carDriftGrip * 0.55 : CFG.carGripRear;
    const latF = vLat * Math.min(1, frontGrip * dt);
    const latR = vLat * Math.min(1, rearGrip * dt);
    car.vel.addScaledVector(right, -(latF + latR) * 0.5);

    // the grip imbalance between the axles turns the car (mild oversteer)
    const slipYaw = (latF - latR) * CFG.carYawFromSlip;
    if (slipYaw > 1e-5 || slipYaw < -1e-5) {
      car.yaw += slipYaw;
      _q1.setFromAxisAngle(up, slipYaw);
      car.q.premultiply(_q1).normalize();
    }

    // rolling resistance: lifting off should let you coast, not stop dead
    const fr = inp.throttle !== 0 ? CFG.carThrottleDrag
      : (inp.drift ? CFG.carRollFriction * 1.5 : CFG.carRollFriction);
    car.vel.multiplyScalar(Math.max(0, 1 - fr * dt));

    const fs = forward.dot(car.vel);
    const maxS = car.boosting ? CFG.carBoostSpeed : CFG.carMaxSpeed;
    if (fs > maxS) car.vel.addScaledVector(forward, maxS - fs);

    // usable steering authority from walking pace upward
    const speedFactor = Math.min(1, Math.abs(fs) / 12);
    const dirSign = fs >= -1 ? 1 : -1;
    const turn = inp.steer * CFG.carTurn * dt * speedFactor * dirSign *
      (inp.drift ? 1.55 : 1) * (inp.throttle !== 0 ? 1 : 0.85);
    car.yaw += turn;
    _q1.setFromAxisAngle(up, turn);
    car.q.premultiply(_q1).normalize();

    _v3.set(0, 1, 0).applyQuaternion(car.q);
    _q2.setFromUnitVectors(_v3, up);
    _q1.identity().slerp(_q2, Math.min(1, CFG.carAlignRate * dt));
    car.q.premultiply(_q1).normalize();
    car.av.multiplyScalar(Math.exp(-16 * dt));

    if (inp.drift && Math.abs(fs) > 40 && Math.random() < 0.6) {
      dustFx.spawn(car.pos.x - right.x * 3, car.pos.y - 1.5, car.pos.z - right.z * 3,
        -right.x * 12 + (Math.random() - 0.5) * 12, 5, -right.z * 12 + (Math.random() - 0.5) * 12,
        0.9, 0.5, 0x9fc4e8, 3, 0.9);
    }

    if (inp.jumpPressed) {
      car.vel.addScaledVector(up, CFG.jumpV);
      car.vel.addScaledVector(forward, Math.max(0, fs) * 0.18);
      car.onSurface = false; car.onWall = false; car.onCeiling = false;
      car.canFlip = true; car.flipTimer = 0; car.airTime = 0;
      car.jumpLock = 0.16;
      for (let i = 0; i < 20; i++)
        sparks.spawn(car.pos.x, car.pos.y - 1.5, car.pos.z,
          (Math.random() - 0.5) * 30, Math.random() * 14, (Math.random() - 0.5) * 30, 0.5, 0.32, 0xcfe8ff);
      Sound.jump();
    }
  } else {
    car.airTime += dt;
    car.vel.y -= CFG.gravity * dt;
    // air drag: without it the car glides in a straight line forever
    car.vel.multiplyScalar(Math.exp(-CFG.carAirDrag * dt));
    if (car.flipTimer > 0) car.flipTimer -= dt;

    if (car.flipTimer <= 0) {
      _lx.set(1, 0, 0).applyQuaternion(car.q);
      _ly.set(0, 1, 0).applyQuaternion(car.q);
      _lz.set(0, 0, 1).applyQuaternion(car.q);
      car.av.addScaledVector(_lx, -inp.throttle * CFG.airPitch * dt);
      car.av.addScaledVector(_ly, -inp.steer * CFG.airYaw * dt);
      car.av.addScaledVector(_lz, -inp.roll * CFG.airRoll * dt);
    }

    if (inp.boost && car.boost > 0) {
      car.boosting = true;
      car.vel.addScaledVector(car.forwardVec(), CFG.boostAccel * dt);
      car.boost = Math.max(0, car.boost - CFG.boostUse * dt);
      spawnFlames(car);
    }

    if (inp.jumpPressed && car.canFlip) {
      car.canFlip = false;
      doFlip(car, inp);
    }

    const avLen = car.av.length();
    if (avLen > 1e-5) {
      _v3.copy(car.av).multiplyScalar(1 / avLen);
      _q1.setFromAxisAngle(_v3, avLen * dt);
      car.q.premultiply(_q1).normalize();
    }
    car.av.multiplyScalar(Math.exp(-0.9 * dt));
  }

  if (inp.jumpPressed) inp.jumpPressed = false;

  car.pos.addScaledVector(car.vel, dt);

  /* ---- surface resolution against the arena SDF ----
     Iterate: on the curved fillet several hull points touch at once, and
     resolving only the deepest one would shove the car off the wall. */
  let stuck = false;
  const hitN = _v5;
  for (let it = 0; it < 4; it++) {
    const cs = carSurface(car);
    if (!cs.hit || cs.pen <= 0) break;
    hitN.set(cs.nx, cs.ny, cs.nz);
    stuck = true;
    // leave a sliver of penetration so contact stays continuous frame to frame;
    // resolving to exactly zero makes onSurface flicker on/off at rest
    if (cs.pen <= 0.02) break;
    car.pos.addScaledVector(hitN, cs.pen - 0.02);
  }

  if (stuck) {
    const n = hitN;
    const vn = car.vel.dot(n);
    _vUp.set(0, 1, 0).applyQuaternion(car.q);
    const facing = _vUp.dot(n);
    const tangentSpeed = _v4.copy(car.vel).addScaledVector(n, -vn).length();
    // "moving away" must scale with speed: near a fillet the normal has a small
    // vertical component, so a fixed threshold would tear a fast car off the wall
    const canStick = car.jumpLock <= 0 && vn <= Math.max(8, tangentSpeed * 0.25) &&
      (n.y > 0.4 || tangentSpeed > CFG.stickSpeed || car.boosting || facing > CFG.stickAlign);

    if (canStick) {
      if (vn < 0) car.vel.addScaledVector(n, -vn);
      car.groundNormal.copy(n);
      if (!car.onSurface) {
        for (let i = 0; i < 16; i++)
          sparks.spawn(car.pos.x, car.pos.y, car.pos.z,
            (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, 0.5, 0.32, 0xa8dcff);
        if (n.y < 0.5) Sound.wall();
        // suspension travel on touchdown
        if (-vn > 5) car.dip = Math.min(1, -vn / 55);
      }
      car.onSurface = true;
      car.onWall = n.y < 0.5;
      car.onCeiling = n.y < -0.5;
    } else {
      if (vn < 0) {
        car.vel.addScaledVector(n, -vn * 1.3);
        car.vel.multiplyScalar(0.85);
        if (-vn > 30) {
          Sound.wall();
          for (let i = 0; i < 16; i++)
            sparks.spawn(car.pos.x, car.pos.y, car.pos.z,
              (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, 0.55, 0.34, 0xffb14a);
        }
      }
      car.onSurface = false; car.onWall = false; car.onCeiling = false;
    }
  } else {
    car.onSurface = false; car.onWall = false; car.onCeiling = false;
    car.groundNormal.set(0, 1, 0);
  }

  /* ---- global speed cap (RL caps boost speed in the air too) ---- */
  const spdNow = car.vel.length();
  if (spdNow > CFG.carBoostSpeed) car.vel.multiplyScalar(CFG.carBoostSpeed / spdNow);

  /* ---- supersonic ---- */
  const sp2 = car.vel.length();
  const wasSuper = car.supersonic;
  car.supersonic = sp2 > CFG.supersonic;
  if (car.supersonic && !wasSuper && car.isPlayer) Sound.supersonic();
  if (car.supersonic && Math.random() < 0.75) {
    const back = car.pos.clone().addScaledVector(car.forwardVec(), -7);
    trailFx.spawn(back.x, back.y, back.z,
      (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8,
      0.9, 0.3, car.team === 0 ? 0x9fd0ff : 0xff9a90, 0, 0.9);
  }

  /* ---- timers ---- */
  if (car.gunCd > 0) car.gunCd -= dt;
  if (car.reload > 0) { car.reload -= dt; if (car.reload <= 0) { car.reload = 0; car.ammo = CFG.magSize; } }
  if (car.stun > 0) car.stun -= dt;
  if (car.hitFlash > 0) car.hitFlash -= dt * 3;
  if (inp.shoot) fire(car);

  /* ---- visuals ---- */
  const ud = car.mesh.userData;
  const fwdSpeed = car.forwardVec().dot(car.vel);
  car.wheelSpin += fwdSpeed * dt / 1.05;
  car.steerVis += ((inp.steer * 0.5) - car.steerVis) * Math.min(1, 12 * dt);
  for (const w of ud.wheels) {
    w.spin.rotation.x = car.wheelSpin;   // one group carries tyre, rim and spokes
    w.holder.rotation.y = w.front ? -car.steerVis : 0;
  }

  const accelPitch = inp.throttle * (car.boosting ? 0.09 : 0.05);
  const rollVis = car.steerVis * Math.min(1, Math.abs(fwdSpeed) / 70) * 0.16;
  // suspension: the body squats on touchdown and springs back
  car.dip *= Math.exp(-9 * dt);
  _e1.set(-accelPitch + car.dip * 0.10, 0, -rollVis);
  _q1.setFromEuler(_e1);
  car.mesh.quaternion.copy(car.q).multiply(_q1);
  _v3.set(0, 1, 0).applyQuaternion(car.q);
  car.mesh.position.copy(car.pos).addScaledVector(_v3, -car.dip * 0.55);

  ud.flame.visible = car.boosting;
  ud.flameCore.visible = car.boosting;
  if (car.boosting) {
    const s = 1 + Math.random() * 0.5;
    ud.flame.scale.set(1, s, 1);
    ud.flameCore.scale.set(1, 1 + Math.random() * 0.7, 1);
    ud.flame.material.opacity = 0.5 + Math.random() * 0.4;
  }
  ud.muzzle.material.emissiveIntensity = car.gunCd > 0 ? 3.4 : 1.0;
  ud.shield.material.opacity = Math.max(0, car.hitFlash) * 0.5;
  ud.glow.material.opacity = 0.22 + (car.boosting ? 0.35 : 0) + Math.max(0, car.hitFlash) * 0.4;
}

/* ==========================================================================
   BALL PHYSICS
   ========================================================================== */
function ballBounce(nx, ny, nz, rest, friction, sfx) {
  const n = _v5.set(nx, ny, nz);
  const vn = ball.vel.dot(n);
  if (vn >= 0) return;

  const vt = _v6.copy(ball.vel).addScaledVector(n, -vn);
  const spinAdd = _v4.copy(n).cross(vt).multiplyScalar(1 / ball.r);

  if (-vn > 12) {
    ball.spin.lerp(spinAdd, 0.55);
    vt.multiplyScalar(1 - friction);
    ball.vel.copy(vt).addScaledVector(n, -vn * rest);
    if (-vn > 30 && sfx) {
      Sound.hit();
      for (let i = 0; i < 10; i++)
        sparks.spawn(ball.pos.x, ball.pos.y, ball.pos.z,
          (Math.random() - 0.5) * 30, Math.random() * 16, (Math.random() - 0.5) * 30, 0.5, 0.3, 0xffc76a);
    }
  } else {
    ball.spin.lerp(spinAdd, 0.3);
    vt.multiplyScalar(0.9995);
    ball.vel.copy(vt);
  }
}

function stepBall(dt) {
  ball.vel.y -= CFG.ballGravity * dt;

  _v1.copy(ball.spin).cross(ball.vel).multiplyScalar(CFG.magnus);
  ball.vel.addScaledVector(_v1, dt);

  ball.vel.multiplyScalar(CFG.ballDrag);
  ball.spin.multiplyScalar(Math.pow(CFG.ballSpinDecay, dt * 60));

  ball.pos.addScaledVector(ball.vel, dt);

  // arena shell
  const ct = arenaSurface(ball.pos, ball.r);
  if (ct.hit && ct.pen > 0) {
    ball.pos.x += ct.nx * ct.pen;
    ball.pos.y += ct.ny * ct.pen;
    ball.pos.z += ct.nz * ct.pen;
    ballBounce(ct.nx, ct.ny, ct.nz, CFG.ballRest, 0.12, true);
    if (ct.ny > 0.7 && ball.pos.y <= ball.r + 0.4) {
      const roll = _v4.set(0, 1, 0).cross(ball.vel).multiplyScalar(1 / ball.r);
      ball.spin.lerp(roll, 0.14);
      // rolling resistance on the ground
      const rd = 1 - CFG.ballRollFriction * dt;
      ball.vel.x *= rd; ball.vel.z *= rd;
    }
  }

  // goal posts + crossbars
  const postR = 1.5;
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const px = sx * CFG.goalHalfW, pz = sz * CFG.fieldZ;
      const dx = ball.pos.x - px, dz = ball.pos.z - pz;
      const d = Math.hypot(dx, dz);
      if (d < ball.r + postR && d > 1e-4 && ball.pos.y < CFG.goalH) {
        const nx = dx / d, nz = dz / d;
        ball.pos.x = px + nx * (ball.r + postR);
        ball.pos.z = pz + nz * (ball.r + postR);
        ballBounce(nx, 0, nz, 0.8, 0.15, true);
        Sound.wall();
      }
    }
    const dz2 = ball.pos.z - sz * CFG.fieldZ;
    const dy2 = ball.pos.y - CFG.goalH;
    const d2 = Math.hypot(dz2, dy2);
    if (d2 < ball.r + postR && d2 > 1e-4 && Math.abs(ball.pos.x) < CFG.goalHalfW) {
      const nz = dz2 / d2, ny = dy2 / d2;
      ball.pos.z = sz * CFG.fieldZ + nz * (ball.r + postR);
      ball.pos.y = CFG.goalH + ny * (ball.r + postR);
      ballBounce(0, ny, nz, 0.8, 0.15, true);
      Sound.wall();
    }
  }

  const sp = ball.vel.length();
  if (sp > CFG.ballMaxSpeed) ball.vel.multiplyScalar(CFG.ballMaxSpeed / sp);
  ball.speed = ball.vel.length();

  const spinLen = ball.spin.length();
  if (spinLen > 0.01) {
    _v1.copy(ball.spin).multiplyScalar(1 / spinLen);
    _q1.setFromAxisAngle(_v1, spinLen * dt);
    ball.mesh.quaternion.premultiply(_q1);
  }
  ball.mesh.position.copy(ball.pos);
  ball.glow.material.opacity = 0.05 + Math.min(0.3, ball.speed / 1400);
  if (ball.speed > 90 && Math.random() < 0.85) {
    trailFx.spawn(ball.pos.x, ball.pos.y, ball.pos.z,
      (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8,
      0.8, 0.32, 0x9fd8ff, 0, 0.94);
  }
}

/* ==========================================================================
   CAR <-> BALL  (OBB vs sphere, with rolling friction -> air dribbles)
   ========================================================================== */
const _obbC = new THREE.Vector3(), _obbL = new THREE.Vector3(), _obbCl = new THREE.Vector3();
function carBallCollide(car, dt) {
  if (car.demolished) return;
  const half = CFG.carHalf;
  _vUp.set(0, 1, 0).applyQuaternion(car.q);
  _obbC.copy(car.pos).addScaledVector(_vUp, CFG.carOffsetY);
  _q1.copy(car.q).invert();
  _obbL.copy(ball.pos).sub(_obbC).applyQuaternion(_q1);

  _obbCl.set(
    Math.max(-half.x, Math.min(half.x, _obbL.x)),
    Math.max(-half.y, Math.min(half.y, _obbL.y)),
    Math.max(-half.z, Math.min(half.z, _obbL.z))
  );

  const delta = _v1.copy(_obbL).sub(_obbCl);
  let dist = delta.length();

  if (dist < 1e-4) {
    const dx = half.x - Math.abs(_obbL.x), dy = half.y - Math.abs(_obbL.y), dz = half.z - Math.abs(_obbL.z);
    if (dx <= dy && dx <= dz) delta.set(Math.sign(_obbL.x) || 1, 0, 0);
    else if (dy <= dz) delta.set(0, Math.sign(_obbL.y) || 1, 0);
    else delta.set(0, 0, Math.sign(_obbL.z) || 1);
    dist = 0;
    _obbCl.copy(_obbL);
  }

  const penetration = ball.r - dist;
  if (penetration <= 0) return;

  const normal = delta.normalize().applyQuaternion(car.q);
  ball.pos.addScaledVector(normal, penetration);

  const rWorld = _obbCl.clone().applyQuaternion(car.q);
  const carPointVel = _v2.copy(car.av).cross(rWorld).add(car.vel);
  const rel = _v3.copy(ball.vel).sub(carPointVel);
  const vn = rel.dot(normal);

  if (vn < 0) {
    // hard hits pop, soft contacts settle (that is what makes air dribbles work)
    const rest = -vn > 55 ? 0.6 : 0.2;
    const mB = 1, mC = 3.4;
    const j = -(1 + rest) * vn / (1 / mB + 1 / mC);
    ball.vel.addScaledVector(normal, j / mB);
    car.vel.addScaledVector(normal, -j / mC * 0.22);

    // tangential friction drags the ball along the car surface, so a hit
    // carries the ball forwards instead of just popping it straight up
    const vt = rel.clone().addScaledVector(normal, -vn);
    const f = 1 - Math.exp(-26 * dt);
    ball.vel.addScaledVector(vt, -f);
    ball.spin.add(new THREE.Vector3().crossVectors(normal, vt).multiplyScalar(0.9 / ball.r));
  }

  const carSpeedN = Math.max(0, carPointVel.dot(normal));
  let push = carSpeedN * 0.3;
  if (car.boosting) push += 40;
  if (car.flipTimer > 0) push += 26;
  ball.vel.addScaledVector(normal, push);

  if (!car.onSurface) car.canFlip = true;

  const strength = carSpeedN + (car.boosting ? 55 : 0);
  if (strength > 18) {
    const count = Math.min(34, 6 + Math.floor(strength / 6));
    for (let i = 0; i < count; i++)
      sparks.spawn(ball.pos.x, ball.pos.y, ball.pos.z,
        (Math.random() - 0.5) * 55, (Math.random() - 0.5) * 55, (Math.random() - 0.5) * 55, 0.65, 0.45, 0xffc76a);
    if (strength > 120) Sound.bigHit(); else Sound.hit();
  }
  const sp = ball.vel.length();
  if (sp > CFG.ballMaxSpeed) ball.vel.multiplyScalar(CFG.ballMaxSpeed / sp);
}

/* ==========================================================================
   CAR <-> CAR  (push apart, or demolish at supersonic speed)
   ========================================================================== */
function demolish(victim, attacker) {
  victim.demolished = true;
  victim.respawn = CFG.demoTime;
  victim.mesh.visible = false;
  victim.vel.set(0, 0, 0);
  Sound.demo();
  shakeAmt = Math.max(shakeAmt, 1.1);
  const col = victim.team === 0 ? 0x6fd0ff : 0xff7a5a;
  for (let i = 0; i < 110; i++)
    sparks.spawn(victim.pos.x, victim.pos.y, victim.pos.z,
      (Math.random() - 0.5) * 110, Math.random() * 85, (Math.random() - 0.5) * 110,
      1.3, 0.9 + Math.random() * 0.7, i % 3 === 0 ? 0xffffff : col);
  for (let i = 0; i < 50; i++)
    boostFx.spawn(victim.pos.x, victim.pos.y, victim.pos.z,
      (Math.random() - 0.5) * 75, Math.random() * 55, (Math.random() - 0.5) * 75, 1.6, 1.1, 0xffd08a);
  if (victim.isPlayer) { damageFlash(); showMsg('DEMOLISHED!', '#ff8a5a', 'YOU GOT BLOWN UP', 1.5); }
  else showMsg('DEMOLITION!', '#7fe0ff', 'YOU BLEW UP THE CPU', 1.5);
}

function carCarCollide(a, b) {
  if (a.demolished || b.demolished) return;
  const d = _v1.copy(b.pos).sub(a.pos);
  const dist = d.length();
  const minD = CFG.carR * 1.9;
  if (dist >= minD || dist < 1e-3) return;
  const n = d.multiplyScalar(1 / dist);

  const aInto = a.vel.dot(n), bInto = -b.vel.dot(n);
  if (a.supersonic && aInto > 50 && !b.supersonic) { demolish(b, a); return; }
  if (b.supersonic && bInto > 50 && !a.supersonic) { demolish(a, b); return; }

  const overlap = (minD - dist) * 0.5;
  a.pos.addScaledVector(n, -overlap);
  b.pos.addScaledVector(n, overlap);

  const rel = _v2.copy(b.vel).sub(a.vel);
  const vn = rel.dot(n);
  if (vn < 0) {
    const j = -(1 + 0.6) * vn * 0.5;
    a.vel.addScaledVector(n, -j);
    b.vel.addScaledVector(n, j);
    if (Math.abs(vn) > 40) {
      Sound.hit();
      for (let i = 0; i < 18; i++)
        sparks.spawn(a.pos.x + n.x * 5, a.pos.y, a.pos.z + n.z * 5,
          (Math.random() - 0.5) * 45, Math.random() * 26, (Math.random() - 0.5) * 45, 0.6, 0.36, 0xffc76a);
    }
  }
}

/* ==========================================================================
   AI
   ========================================================================== */
let aiSkill = 0.74;
const _ai = {
  behind: new THREE.Vector3(), target: new THREE.Vector3(),
  predict: new THREE.Vector3(), goal: new THREE.Vector3(0, 0, -CFG.fieldZ),
  dir: new THREE.Vector3(),
  a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(),
};

function updateAI() {
  const inp = cpu.input;
  inp.jumpPressed = false;
  inp.drift = false;

  if (gameState !== 'play' || cpu.stun > 0 || cpu.demolished) {
    inp.throttle = 0; inp.steer = 0; inp.boost = false; inp.shoot = false;
    return;
  }

  const distToBall = cpu.pos.distanceTo(ball.pos);
  const lead = THREE.MathUtils.clamp(distToBall / 220, 0, 0.5) * aiSkill;
  _ai.predict.copy(ball.pos).addScaledVector(ball.vel, lead).setY(0);

  // unit vector from our goal through the ball: the line we want to strike along
  _ai.dir.copy(_ai.predict).sub(_ai.goal).setY(0);
  if (_ai.dir.lengthSq() < 1e-4) _ai.dir.set(0, 0, 1);
  _ai.dir.normalize();

  // stand well behind the ball on that line so we arrive already pointing goalwards
  _ai.behind.copy(_ai.predict).addScaledVector(_ai.dir, 70).setY(0);
  const wob = (1 - aiSkill) * 10;
  _ai.behind.x += Math.sin(performance.now() * 0.0011) * wob;
  _ai.behind.z += Math.cos(performance.now() * 0.0009) * wob;

  const sideDot = _ai.a.copy(cpu.pos).sub(_ai.predict).dot(_ai.dir);  // >0 = we are behind the ball
  // perpendicular distance from us to the strike line (goal -> ball). Only commit
  // to hitting the ball when we are actually lined up, otherwise we slice it wide.
  const perpX = cpu.pos.x - _ai.predict.x - _ai.dir.x * sideDot;
  const perpZ = cpu.pos.z - _ai.predict.z - _ai.dir.z * sideDot;
  const perp = Math.hypot(perpX, perpZ);
  const toBall = _ai.b.copy(ball.pos).sub(cpu.pos).setY(0);
  const facingBall = toBall.lengthSq() > 1 ? cpu.forwardVec().dot(toBall.normalize()) : 1;

  const defending = _ai.predict.z > CFG.fieldZ - 110 && Math.abs(_ai.predict.x) < 90;

  let target = _ai.target;
  if (defending) target.copy(ball.pos).setY(0);
  else if (sideDot > 4 && perp < 34 && distToBall < 130 && facingBall > 0.45) {
    // lined up: aim *through* the ball so we commit instead of orbiting it
    target.copy(ball.pos).addScaledVector(_ai.dir, -30).setY(0);
  } else {
    target.copy(_ai.behind);
  }

  // low on boost and not in a hurry -> detour to the nearest big pad
  if (!defending && cpu.boost < 34 && distToBall > 150) {
    let bestPad = null, bestD = 1e9;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p.cd > 0 || !p.big) continue;
      const d = Math.hypot(p.x - cpu.pos.x, p.z - cpu.pos.z);
      if (d < bestD) { bestD = d; bestPad = p; }
    }
    if (bestPad && bestD < 300) target.set(bestPad.x, 0, bestPad.z);
  }

  // airborne with nothing to do -> fall flat instead of thrashing
  if (!cpu.onSurface && ball.pos.y < 20) {
    inp.throttle = 0; inp.steer = 0; inp.roll = 0; inp.boost = false; inp.shoot = false;
    return;
  }

  const toTarget = _ai.c.copy(target).sub(cpu.pos).setY(0);
  const dist = toTarget.length();
  if (dist < 0.01) { inp.throttle = 0; return; }
  toTarget.multiplyScalar(1 / dist);

  const desiredYaw = Math.atan2(toTarget.x, toTarget.z);
  let diff = desiredYaw - cpu.yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;

  // steer = +1 raises yaw, and yaw is atan2(forward.x, forward.z),
  // so to face `desiredYaw` the steer must have the SAME sign as the error
  inp.steer = THREE.MathUtils.clamp(diff * 2.4, -1, 1);
  const align = Math.max(0, Math.cos(diff));
  inp.throttle = align > 0.35 ? 1 : (dist > 30 ? 0.6 : -0.5);
  if (Math.abs(diff) > 1.9 && cpu.vel.length() < 40) {
    inp.throttle = -1;
    inp.steer = THREE.MathUtils.clamp(diff * 1.4, -1, 1);
  }

  const wantBoost = (dist > 45 || defending || (sideDot > 10 && distToBall < 90)) && align > 0.7;
  inp.boost = wantBoost && cpu.boost > 6 && Math.random() < 0.93;

  if (cpu.onSurface && ball.pos.y > 26 && ball.pos.y < 90 && distToBall < 40 && Math.random() < 0.05) {
    inp.jump = true; inp.jumpPressed = true;
  } else {
    inp.jump = false;
  }

  const toBallDir = _ai.b.copy(ball.pos).sub(cpu.pos).setY(0).normalize();
  const facing = cpu.forwardVec().dot(toBallDir);
  // guns push the ball horizontally, which is the AI's most reliable route to
  // goal: a flat 150 u/s shove instead of a lofted car hit
  const attacking = _ai.predict.z < -40 && sideDot > -20;
  inp.shoot = distToBall < 190 && facing > 0.8 && cpu.ammo > 0 && cpu.reload <= 0 &&
    Math.random() < (attacking ? 0.5 : 0.04);

  if (Math.abs(cpu.pos.x) > CFG.fieldX - 30 && Math.abs(toTarget.x) > 0.7) {
    inp.steer = THREE.MathUtils.clamp(inp.steer + Math.sign(cpu.pos.x) * 0.5, -1, 1);
  }
}

/* ==========================================================================
   GAME STATE
   ========================================================================== */
let gameState = 'menu';
let stateTimer = 0;
let scoreBlue = 0, scoreRed = 0;
let matchClock = CFG.matchTime;
let ballCam = true;
let paused = false;
let shakeAmt = 0;

const el = {
  msg: document.getElementById('msg'),
  scoreBlue: document.getElementById('scoreBlue'),
  scoreRed: document.getElementById('scoreRed'),
  timer: document.getElementById('timer'),
  boostFill: document.getElementById('boostFill'),
  speed: document.getElementById('speed'),
  speedNum: document.getElementById('speedNum'),
  superTag: document.getElementById('superTag'),
  ammo: document.getElementById('ammo'),
  ammoMax: document.getElementById('ammoMax'),
  ammoRow: document.getElementById('ammoRow'),
  reload: document.getElementById('reload'),
  overlay: document.getElementById('overlay'),
  startBtn: document.getElementById('startBtn'),
  crosshair: document.getElementById('crosshair'),
  hitmarker: document.getElementById('hitmarker'),
  damage: document.getElementById('damage'),
  radar: document.getElementById('radar'),
};
const radarCtx = el.radar.getContext('2d');

function showMsg(text, color, sub, duration) {
  el.msg.innerHTML = text + (sub ? '<span class="small">' + sub + '</span>' : '');
  el.msg.style.color = color;
  el.msg.classList.add('show');
  clearTimeout(showMsg._t);
  if (duration > 0) showMsg._t = setTimeout(() => el.msg.classList.remove('show'), duration * 1000);
}
function flashHitmarker() {
  el.hitmarker.style.transition = 'none'; el.hitmarker.style.opacity = '1';
  requestAnimationFrame(() => { el.hitmarker.style.transition = 'opacity .25s ease'; el.hitmarker.style.opacity = '0'; });
}
function damageFlash() {
  el.damage.style.transition = 'none'; el.damage.style.opacity = '0.85';
  requestAnimationFrame(() => { el.damage.style.transition = 'opacity .35s ease'; el.damage.style.opacity = '0'; });
  shakeAmt = Math.max(shakeAmt, 0.7);
}

function resetRound() {
  player.spawnPos.set(0, CFG.carRide, -205);
  player.spawnYaw = 0;
  cpu.spawnPos.set(0, CFG.carRide, 205);
  cpu.spawnYaw = Math.PI;
  player.reset(); cpu.reset();
  ball.pos.set(0, CFG.ballR, 0);
  ball.vel.set(0, 0, 0);
  ball.spin.set(0, 0, 0);
  ball.mesh.position.copy(ball.pos);
  ball.mesh.quaternion.identity();
  bullets.forEach(b => scene.remove(b.mesh)); bullets.length = 0;
  for (const p of pads) { p.cd = 0; p.mesh.visible = true; p.ring.visible = true; p.halo.visible = true; p.mesh.scale.setScalar(1); }
  camPos.set(0, 42, -205 - 48);
}

function startMatch() {
  scoreBlue = 0; scoreRed = 0;
  matchClock = CFG.matchTime;
  aiSkill = 0.74;
  resetRound();
  updateHUD();
  el.overlay.classList.add('hidden');
  gameState = 'countdown';
  stateTimer = 3.4;
  Sound.init();
}

/* The HUD is plain DOM: rewriting it every frame forces the browser to reparse
   markup and relayout, so everything is cached and only touched when it changes. */
const _hud = { blue: -1, red: -1, time: '', boost: -1, speed: '', ammo: -1, reload: '', super: null };
function updateHUD() {
  if (_hud.blue !== scoreBlue) { _hud.blue = scoreBlue; el.scoreBlue.textContent = scoreBlue; }
  if (_hud.red !== scoreRed) { _hud.red = scoreRed; el.scoreRed.textContent = scoreRed; }

  const m = Math.floor(Math.max(0, matchClock) / 60);
  const s = Math.floor(Math.max(0, matchClock) % 60);
  const timeStr = m + ':' + String(s).padStart(2, '0');
  if (_hud.time !== timeStr) {
    _hud.time = timeStr;
    el.timer.textContent = timeStr;
    el.timer.classList.toggle('low', matchClock <= 20 && gameState === 'play');
  }

  const boostPct = Math.round(player.boost);
  if (_hud.boost !== boostPct) { _hud.boost = boostPct; el.boostFill.style.width = boostPct + '%'; }

  const kmh = Math.round(player.vel.length() * 3.2);
  if (_hud.speed !== kmh) { _hud.speed = kmh; el.speedNum.textContent = kmh; }
  if (_hud.super !== player.supersonic) {
    _hud.super = player.supersonic;
    el.superTag.style.display = player.supersonic ? 'inline' : 'none';
  }

  if (_hud.ammo !== player.ammo) {
    _hud.ammo = player.ammo;
    el.ammo.textContent = player.ammo;
    el.ammoRow.classList.toggle('empty', player.ammo === 0);
  }
  const reloadStr = player.reload > 0 ? 'RELOADING...' : '';
  if (_hud.reload !== reloadStr) { _hud.reload = reloadStr; el.reload.textContent = reloadStr; }
}

/* ==========================================================================
   INPUT
   ========================================================================== */
const keys = Object.create(null);
window.addEventListener('keydown', e => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].indexOf(e.code) !== -1) e.preventDefault();
  if (!keys[e.code]) {
    if (e.code === 'Space') player.input.jumpPressed = true;
    if (e.code === 'KeyP' && (gameState === 'play' || gameState === 'countdown')) {
      paused = !paused; document.body.classList.toggle('paused', paused);
    }
    if (e.code === 'KeyR' && gameState === 'play') player.reset();
    if (e.code === 'KeyC') ballCam = !ballCam;
    if (e.code === 'Enter' && gameState === 'over') startMatch();
  }
  keys[e.code] = true;
});
window.addEventListener('keyup', e => { keys[e.code] = false; });

renderer.domElement.addEventListener('pointerdown', e => { if (e.button === 0) keys['Mouse0'] = true; });
window.addEventListener('pointerup', e => { if (e.button === 0) keys['Mouse0'] = false; });
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

function readPlayerInput() {
  const inp = player.input;
  inp.throttle = (keys['KeyW'] || keys['ArrowUp']) ? 1 : ((keys['KeyS'] || keys['ArrowDown']) ? -1 : 0);
  inp.steer = (keys['KeyD'] || keys['ArrowRight']) ? -1 : ((keys['KeyA'] || keys['ArrowLeft']) ? 1 : 0);
  inp.boost = !!(keys['ShiftLeft'] || keys['ShiftRight']);
  inp.jump = !!keys['Space'];
  if (keys['Space'] && !player.prevJump) inp.jumpPressed = true;
  player.prevJump = !!keys['Space'];
  inp.roll = keys['KeyE'] ? -1 : (keys['KeyQ'] ? 1 : 0);
  inp.drift = !!(keys['ControlLeft'] || keys['ControlRight'] || keys['KeyX']);
  inp.shoot = !!(keys['Mouse0'] || keys['KeyJ']);
}

/* ==========================================================================
   GOALS / ROUND FLOW
   ========================================================================== */
function checkGoal() {
  if (gameState !== 'play') return;
  const mouth = Math.abs(ball.pos.x) < CFG.goalHalfW && ball.pos.y < CFG.goalH;
  if (!mouth) return;
  if (ball.pos.z > CFG.fieldZ + ball.r * 0.4) scoreGoal(0);
  else if (ball.pos.z < -CFG.fieldZ - ball.r * 0.4) scoreGoal(1);
}

function scoreGoal(team) {
  if (team === 0) scoreBlue++; else scoreRed++;
  gameState = 'goal';
  stateTimer = 3.0;
  shakeAmt = 1.7;
  Sound.goal();
  const col = team === 0 ? '#6fd0ff' : '#ff7a80';
  showMsg(team === 0 ? 'GOAL!' : 'CPU SCORES', col,
    team === 0 ? 'NICE SHOT, CHAMPION' : 'DEFEND YOUR NET', 2.8);
  const zz = team === 0 ? CFG.fieldZ : -CFG.fieldZ;
  for (let i = 0; i < 180; i++) {
    const c = i % 2 ? sparks : boostFx;
    c.spawn(ball.pos.x + (Math.random() - 0.5) * 22, Math.max(2, ball.pos.y) + Math.random() * 14, zz + (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 150, Math.random() * 120, (Math.random() - 0.5) * 150,
      1.5, 1.3, team === 0 ? 0x8fd0ff : 0xff8a70);
  }
  goalData[team === 0 ? 1 : 0].flash = 1;
  updateHUD();
}

function endMatch() {
  gameState = 'over';
  Sound.whistle();
  const win = scoreBlue > scoreRed ? 'YOU WIN!' : (scoreBlue < scoreRed ? 'CPU WINS' : 'DRAW');
  const col = scoreBlue > scoreRed ? '#7ee0ff' : (scoreBlue < scoreRed ? '#ff8a90' : '#ffe066');
  el.overlay.classList.remove('hidden');
  el.overlay.querySelector('h1').innerHTML = win + '<span>FINAL ' + scoreBlue + ' - ' + scoreRed + '</span>';
  el.overlay.querySelector('.sub').textContent = 'PRESS ENTER TO REMATCH';
  el.startBtn.textContent = 'REMATCH';
  showMsg(win, col, '', 3);
}

/* ==========================================================================
   CAMERA
   ========================================================================== */
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
const lookAt = new THREE.Vector3();

function updateCamera(dt) {
  const car = player;
  const back = car.forwardVec().multiplyScalar(-1);

  if (ballCam) {
    const toBall = ball.pos.clone().sub(car.pos);
    const distBall = toBall.length();
    const dirBall = toBall.clone().normalize();
    const desired = car.pos.clone()
      .addScaledVector(dirBall, -36 - Math.min(34, distBall * 0.1))
      .add(new THREE.Vector3(0, 18 + Math.min(18, distBall * 0.04), 0));
    camPos.lerp(desired, 1 - Math.exp(-6 * dt));
    camTarget.lerp(ball.pos.clone().add(new THREE.Vector3(0, 3, 0)), 1 - Math.exp(-11 * dt));
  } else {
    const desired = car.pos.clone()
      .addScaledVector(back, 32)
      .add(new THREE.Vector3(0, 13, 0));
    camPos.lerp(desired, 1 - Math.exp(-7 * dt));
    camTarget.lerp(car.pos.clone().addScaledVector(car.forwardVec(), 28).add(new THREE.Vector3(0, 5, 0)), 1 - Math.exp(-11 * dt));
  }
  lookAt.copy(camTarget);

  camPos.x = THREE.MathUtils.clamp(camPos.x, -CFG.fieldX + 4, CFG.fieldX - 4);
  camPos.y = THREE.MathUtils.clamp(camPos.y, 3, CFG.fieldY - 3);
  camPos.z = THREE.MathUtils.clamp(camPos.z, -CFG.fieldZ - CFG.goalDepth, CFG.fieldZ + CFG.goalDepth);

  camera.position.copy(camPos);
  if (shakeAmt > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shakeAmt * 3;
    camera.position.y += (Math.random() - 0.5) * shakeAmt * 3;
    camera.position.z += (Math.random() - 0.5) * shakeAmt * 3;
    shakeAmt *= Math.exp(-4 * dt);
  }
  camera.lookAt(lookAt);

  const spd = car.vel.length();
  const targetFov = 78 + Math.min(26, spd * 0.09);
  camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-5 * dt));
  camera.updateProjectionMatrix();

  // motion blur strength follows speed (and a little from the camera whip)
  if (motionUniforms && blurPass) {
    const want = Math.min(0.055, Math.max(0, (spd - CFG.carMaxSpeed * 0.55) / 5200));
    motionUniforms.uStrength.value += (want - motionUniforms.uStrength.value) * Math.min(1, 8 * dt);
    motionUniforms.uCenter.value.set(0.5, 0.5);
    // skip the whole pass when there is no blur to draw
    blurPass.enabled = qualityLevel >= 2 && motionUniforms.uStrength.value > 0.0015;
  }
}

/* ==========================================================================
   RADAR
   ========================================================================== */
function drawRadar() {
  const w = el.radar.width, h = el.radar.height;
  const g = radarCtx;
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(6,12,24,0.85)'; g.fillRect(0, 0, w, h);

  const pad = 8;
  const sx = (w - pad * 2) / (CFG.fieldX * 2);
  const sz = (h - pad * 2) / (CFG.fieldZ * 2);
  const px = x => pad + (x + CFG.fieldX) * sx;
  const pz = z => pad + (z + CFG.fieldZ) * sz;

  g.strokeStyle = 'rgba(90,170,255,0.4)'; g.lineWidth = 1.5;
  g.strokeRect(pad, pad, w - pad * 2, h - pad * 2);
  g.beginPath(); g.moveTo(pad, h / 2); g.lineTo(w - pad, h / 2); g.stroke();
  g.beginPath(); g.arc(w / 2, h / 2, 24, 0, Math.PI * 2); g.stroke();

  g.fillStyle = 'rgba(255,110,40,0.9)';
  g.fillRect(px(-CFG.goalHalfW), pz(CFG.fieldZ) - 4, CFG.goalHalfW * 2 * sx, 5);
  g.fillStyle = 'rgba(70,160,255,0.9)';
  g.fillRect(px(-CFG.goalHalfW), pz(-CFG.fieldZ) - 1, CFG.goalHalfW * 2 * sx, 5);

  for (const p of pads) {
    if (p.cd > 0) continue;
    g.fillStyle = p.big ? 'rgba(255,196,0,0.95)' : 'rgba(255,224,102,0.5)';
    g.beginPath(); g.arc(px(p.x), pz(p.z), p.big ? 4.5 : 2.2, 0, Math.PI * 2); g.fill();
  }

  g.fillStyle = 'rgba(255,240,150,0.9)';
  for (const b of bullets) g.fillRect(px(b.pos.x) - 1, pz(b.pos.z) - 1, 2, 2);

  const dot = (car, color) => {
    if (car.demolished) return;
    const f = car.forwardVec();
    g.save();
    g.translate(px(car.pos.x), pz(car.pos.z));
    g.rotate(Math.atan2(f.x, f.z));
    g.fillStyle = color;
    g.beginPath(); g.moveTo(0, -8); g.lineTo(6, 7); g.lineTo(-6, 7); g.closePath(); g.fill();
    g.restore();
  };
  dot(cpu, 'rgba(255,80,90,0.95)');
  dot(player, 'rgba(90,190,255,1)');

  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(px(ball.pos.x), pz(ball.pos.z), 3.6, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(120,220,255,0.9)'; g.lineWidth = 1;
  g.beginPath(); g.arc(px(ball.pos.x), pz(ball.pos.z), 6, 0, Math.PI * 2); g.stroke();
}

/* ==========================================================================
   AIM CROSSHAIR
   ========================================================================== */
const _aimDir = new THREE.Vector3();
function updateCrosshair() {
  _aimDir.copy(ball.pos).sub(player.pos);
  const dist = _aimDir.length();
  _aimDir.normalize();
  const hot = dist < 180 && player.forwardVec().dot(_aimDir) > 0.94;
  el.crosshair.classList.toggle('hot', hot);
}

/* ==========================================================================
   SHADOW RIG (follows the action so a huge arena still gets crisp shadows)
   ========================================================================== */
const _shadowFocus = new THREE.Vector3();
function updateShadowRig() {
  _shadowFocus.copy(player.pos).lerp(ball.pos, 0.55);
  sun.position.set(_shadowFocus.x + 130, 260, _shadowFocus.z + 110);
  sun.target.position.copy(_shadowFocus);
  sun.target.updateMatrixWorld();
  if (arena.userData.shell) arena.userData.shell.uniforms.uCamera.value.copy(camera.position);
}

/* ==========================================================================
   STEP + LOOP
   ========================================================================== */
function step(dt) {
  if (gameState === 'play') {
    matchClock -= dt;
    if (matchClock <= 0) { matchClock = 0; updateHUD(); endMatch(); return; }
    readPlayerInput();
  } else {
    const inp = player.input;
    inp.throttle = 0; inp.steer = 0; inp.boost = false; inp.shoot = false;
    inp.drift = false; inp.jumpPressed = false; inp.roll = 0;
  }

  updateAI();
  stepCar(player, dt);
  stepCar(cpu, dt);
  carBallCollide(player, dt);
  carBallCollide(cpu, dt);
  carCarCollide(player, cpu);
  stepBall(dt);
  updateBullets(dt);
  updatePads(dt, player, true);
  updatePads(dt, cpu, false);
  checkGoal();

  if (gameState === 'countdown' || gameState === 'goal') {
    stateTimer -= dt;
    if (stateTimer <= 0) {
      if (gameState === 'goal') { resetRound(); gameState = 'countdown'; stateTimer = 3.4; }
      else { gameState = 'play'; showMsg('GO!', '#9fffc4', '', 0.9); }
    }
  }
  for (const gd of goalData) {
    if (gd.flash > 0.002) {
      gd.flash *= Math.exp(-3 * dt);
      const m = gd.strip.material;
      m.opacity = Math.min(1, 0.95 + gd.flash * 0.05);
      m.color.setHex(gd.colorHex).lerp(WHITE, Math.min(1, gd.flash));
      gd.strip.scale.x = 1 + gd.flash * 0.6;
    }
  }
}

function updateCountdownMsg() {
  if (gameState !== 'countdown') { updateCountdownMsg._last = null; return; }
  const n = Math.ceil(stateTimer - 0.4);
  if (n >= 1 && n <= 3 && updateCountdownMsg._last !== n) {
    updateCountdownMsg._last = n;
    showMsg(String(n), '#bfe4ff', '', 0);
  }
}

let lastTime = performance.now();
let acc = 0;

/* ---- adaptive quality controller ----
   Watches the rolling frame time and degrades / restores resolution and post
   effects so the game holds a smooth frame rate on weaker GPUs. */
let qAcc = 0, qFrames = 0;
function updateQuality(dt) {
  qAcc += dt; qFrames++;
  if (qAcc < 0.6) return;
  const avg = qAcc / qFrames;
  qAcc = 0; qFrames = 0;

  if (avg > 0.0225) {                      // under ~44 fps: step quality down
    if (qualityLevel >= 2) { qualityLevel = 1; if (bloomPass) bloomPass.enabled = true; if (blurPass) blurPass.enabled = false; }
    else if (qualityLevel === 1) { qualityLevel = 0; if (bloomPass) bloomPass.enabled = false; }
    else if (renderScale > 0.62) { renderScale = Math.max(0.62, renderScale - 0.12); onResize(); }
  } else if (avg < 0.0140) {               // over ~71 fps: we have headroom
    if (renderScale < 1) { renderScale = Math.min(1, renderScale + 0.08); onResize(); }
    else if (qualityLevel === 0) { qualityLevel = 1; if (bloomPass) bloomPass.enabled = true; }
    else if (qualityLevel === 1) { qualityLevel = 2; if (bloomPass) bloomPass.enabled = true; }
  }
}

let radarTick = 0;
let shadowTick = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt > 0.1) dt = 0.1;

  if (!paused) {
    acc += dt;
    let guard = 0;
    while (acc >= STEP && guard < 14) { step(STEP); acc -= STEP; guard++; }
    if (guard >= 14) acc = 0;
    sparks.update(dt);
    boostFx.update(dt);
    trailFx.update(dt);
    dustFx.update(dt);
    updateCountdownMsg();
    updateHUD();
    updateCrosshair();
    updateQuality(dt);
  }

  updateCamera(paused ? 0.0001 : dt);

  // shadows and the minimap do not need to run at full frame rate
  if (++shadowTick >= 2) {
    shadowTick = 0;
    updateShadowRig();
    renderer.shadowMap.needsUpdate = true;
  }
  if (arena.userData.shell) arena.userData.shell.uniforms.uTime.value = now * 0.001;
  if (++radarTick >= 3) { radarTick = 0; drawRadar(); }

  if (composer) composer.render(); else renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  applyRenderScale();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) {
    if (composer.setPixelRatio) composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(window.innerWidth, window.innerHeight);
  }
}
window.addEventListener('resize', onResize);

el.startBtn.addEventListener('click', () => startMatch());
window.addEventListener('pointerdown', () => Sound.init(), { once: true });
window.addEventListener('keydown', () => Sound.init(), { once: true });

/* ---- boot ---- */
player.spawnPos.set(0, CFG.carRide, -205); player.spawnYaw = 0;
cpu.spawnPos.set(0, CFG.carRide, 205); cpu.spawnYaw = Math.PI;
player.reset(); cpu.reset();
ball.pos.set(0, CFG.ballR, 0);
ball.mesh.position.copy(ball.pos);
camPos.set(0, 55, -205 - 60);
camera.position.copy(camPos);
updateShadowRig();
renderer.shadowMap.needsUpdate = true;
drawRadar();
updateHUD();
requestAnimationFrame(frame);



