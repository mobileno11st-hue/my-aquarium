// 내 어항 — 잡은 물고기 사진을 오려서 어항에 넣는 앱
const $ = (id) => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
function toBlob(canvas, type, q) { return new Promise((res) => canvas.toBlob(res, type, q)); }
function loadImg(blob) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(blob); });
}

// ───────────────────────── 저장소 (폰 안에만 저장)
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('my-aquarium', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('fish', { keyPath: 'id' });
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function store(mode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction('fish', mode); const rq = fn(t.objectStore('fish'));
    t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}

// ───────────────────────── 사진 정보(EXIF): 찍은 날짜와 위치
function readExif(buf) {
  const out = {};
  try {
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return out;
    let p = 2;
    while (p + 10 < v.byteLength) {
      const m = v.getUint16(p), len = v.getUint16(p + 2);
      if ((m & 0xFF00) !== 0xFF00 || m === 0xFFDA) break;
      if (m === 0xFFE1 && v.getUint32(p + 4) === 0x45786966) { tiff(p + 10); break; }
      p += 2 + len;
    }
    function tiff(t) {
      const le = v.getUint16(t) === 0x4949;
      const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
      const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = v.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); } return s; };
      const ifd = (o, cb) => { const n = u16(o); for (let i = 0; i < n; i++) { const e = o + 2 + i * 12; cb(u16(e), u32(e + 4), e + 8); } };
      const dms = (o) => { const r = (k) => u32(o + k) / (u32(o + k + 4) || 1); return r(0) + r(8) / 60 + r(16) / 3600; };
      let exifOff = 0, gpsOff = 0, dt = '';
      ifd(t + u32(t + 4), (tag, cnt, vo) => {
        if (tag === 0x8769) exifOff = u32(vo); else if (tag === 0x8825) gpsOff = u32(vo);
        else if (tag === 0x0132) dt = str(t + u32(vo), cnt);
      });
      if (exifOff) ifd(t + exifOff, (tag, cnt, vo) => { if (tag === 0x9003) dt = str(t + u32(vo), cnt) || dt; });
      const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(dt);
      if (m && m[1] > '1990') out.date = `${m[1]}-${m[2]}-${m[3]}`;
      if (gpsOff) {
        let latR = 'N', lonR = 'E', lat, lon;
        ifd(t + gpsOff, (tag, cnt, vo) => {
          if (tag === 1) latR = String.fromCharCode(v.getUint8(vo)); else if (tag === 3) lonR = String.fromCharCode(v.getUint8(vo));
          else if (tag === 2) lat = dms(t + u32(vo)); else if (tag === 4) lon = dms(t + u32(vo));
        });
        if (isFinite(lat) && isFinite(lon) && (lat || lon)) { out.lat = latR === 'S' ? -lat : lat; out.lon = lonR === 'W' ? -lon : lon; }
      }
    }
  } catch { /* 정보가 없거나 깨진 사진 */ }
  return out;
}

// 좌표 → 지명 (인터넷이 될 때만, OpenStreetMap)
async function placeName(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=ko&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
    const j = await r.json(); const a = j.address || {};
    const big = a.province || a.state || '';
    const parts = [big, a.city || a.county, a.county, a.town || a.village || a.suburb || a.borough || a.city_district || a.quarter];
    return [...new Set(parts.filter(Boolean))].join(' ') || j.name || '';
  } catch { return ''; }
}
const coordText = (r) => `${r.lat >= 0 ? '북위' : '남위'} ${Math.abs(r.lat).toFixed(4)}°, ${r.lon >= 0 ? '동경' : '서경'} ${Math.abs(r.lon).toFixed(4)}°`;
const mapLink = (r) => `https://map.kakao.com/link/map/${encodeURIComponent(r.name || '잡은 곳')},${r.lat},${r.lon}`;
function dateText(d) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${m[1]}년 ${+m[2]}월 ${+m[3]}일` : ''; }

// ───────────────────────── 어항
const tank = $('tank'), ctx = tank.getContext('2d');
let W = 0, H = 0, DPR = 1, sandY = 0, pxPerCm = 4;
const fishes = []; let shown = [];
const LS = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setLS = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 안 돼도 동작 */ } };
let water = LS('aq-water', 'sea'), showTags = LS('aq-tags', '0') === '1', timeMode = LS('aq-time', 'auto'), dayCur = null;

// 어종 이름으로 헤엄 방식·사는 물을 미리 골라 준다 (입력 화면에서 언제든 바꿀 수 있음)
const STYLE_GUESS = [
  [/광어|넙치|가자미|도다리|가오리|홍어|양태|아귀|서대|박대|망둑|망둥|메기|동자개|빠가|장어|성대/, 'bottom'],
  [/갈치/, 'upright'],
  [/전갱이|고등어|방어|부시리|삼치|학꽁치|학공치|숭어|전어|멸치|청어|정어리|벤자리|피라미|갈겨니|은어|빙어|블루길|강준치|끄리|만새기|참치|다랑어/, 'school'],
  [/우럭|볼락|쏘가리|능성어|노래미|놀래미|쏨뱅이|붉바리|다금바리|자바리|돌돔|강담돔|혹돔|꺽지|열기|용치/, 'rock'],
];
const FRESH_GUESS = /붕어|잉어|배스|쏘가리|가물치|메기|송어|블루길|강준치|누치|끄리|피라미|갈겨니|은어|빙어|꺽지|동자개|빠가|향어|산천어|민물|초어|백연|마자|모래무지|버들치|뱀장어/;
const guessStyle = (name) => (STYLE_GUESS.find(([re]) => re.test(name || '')) || [0, 'normal'])[1];
const guessWater = (name) => (FRESH_GUESS.test(name || '') ? 'fresh' : 'sea');

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => { const A = hex(a), B = hex(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`; };
const SCENES = {
  sea: {
    day: ['#35a9d6', '#12689f', '#072c50'], night: ['#0b2f55', '#061c38', '#020b1a'], sand: ['#b9ad84', '#4f5546'], rock: ['#687480', '#262c34'], rockX: 0.8, sway: 26,
    lumps: [{ dx: -0.1, w: 0.6, h: 0.5 }, { dx: 0.02, w: 0.8, h: 1 }, { dx: 0.13, w: 0.55, h: 0.6 }],
    weeds: Array.from({ length: 8 }, (_, i) => ({ x: (i + rand(0.2, 0.8)) / 8, h: rand(0.12, 0.3), seed: rand(0, 9), hue: rand(95, 150), w: rand(5, 10) })),
    pads: [],
  },
  fresh: {
    day: ['#7fb894', '#2f7a63', '#123c34'], night: ['#143a34', '#0a2422', '#030e0e'], sand: ['#7d7355', '#38382a'], rock: ['#77775f', '#2c2e26'], rockX: 0.22, sway: 9,
    lumps: [{ dx: -0.07, w: 0.75, h: 0.5 }, { dx: 0.07, w: 0.5, h: 0.75 }],
    weeds: Array.from({ length: 18 }, (_, i) => ({ x: (i + rand(0.1, 0.9)) / 18, h: rand(0.2, 0.52), seed: rand(0, 9), hue: rand(65, 110), w: rand(2.5, 5) })),
    pads: Array.from({ length: 5 }, (_, i) => ({ x: (i + rand(0.2, 0.8)) / 5, r: rand(22, 40) })),
  },
};
const rockR = () => Math.min(W, H) * 0.2;
const bubbles = [], pellets = [], groups = new Map();
const pebbles = Array.from({ length: 26 }, () => ({ x: Math.random(), y: rand(0.2, 0.9), r: rand(2, 7), c: rand(60, 120) }));

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  tank.width = Math.round(W * DPR); tank.height = Math.round(H * DPR);
  sandY = H * 0.88; rescale();
}
function rescale() {
  // 어항 가로가 실제로 몇 cm인지: 가장 큰 물고기가 여유 있게 들어가도록
  const maxLen = shown.reduce((m, f) => Math.max(m, f.rec.lengthCm), 0);
  const viewCm = Math.max(90, maxLen * 2.4) * Math.max(1, (W / H) * 0.75);
  pxPerCm = W / viewCm;
}
addEventListener('resize', resize);

// 물고기 한 마리 그리기: 세로 조각으로 잘라 꼬리 쪽일수록 크게 물결치게 한다 (그림은 머리가 왼쪽)
function drawFish(c, img, x, y, L, face, tilt, phase, up = false, amp = 1) {
  const iw = img.width, ih = img.height, s = L / iw, hh = ih * s;
  const N = clamp(Math.round(L / 5), 14, 44), dw = L / N, sw = iw / N;
  let fs = face; if (Math.abs(fs) < 0.06) fs = fs < 0 ? -0.06 : 0.06;
  c.save(); c.translate(x, y);
  if (up) { c.rotate(Math.PI / 2 + tilt); c.scale(1, fs); }          // 갈치처럼 머리를 위로 세운 자세
  else { c.rotate(tilt * Math.sign(face || 1)); c.scale(-fs, 1); }
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N, env = 0.1 + 0.9 * t * t;
    const off = Math.sin(phase - t * 5.2) * env * L * 0.042 * amp;
    c.drawImage(img, i * sw, 0, sw, ih, -L / 2 + i * dw, -hh / 2 + off, dw + 0.8, hh);
  }
  c.restore();
}

const fishL = (f) => f.rec.lengthCm * pxPerCm * (0.88 + 0.12 * f.depth);
const fishH = (f) => fishL(f) * f.img.height / f.img.width;
function bounds(f) {
  const up = f.rec.style === 'upright', L = fishL(f), hh = fishH(f), ex = up ? hh / 2 : L / 2, ey = up ? L / 2 : hh / 2;
  const m = Math.min(W / 2, ex + 8), top = Math.min(H * 0.14 + ey, H * 0.4), bot = Math.max(top + 10, sandY - ey - 6);
  return { up, L, hh, ex, ey, m, top, bot };
}
function retarget(f) {
  const b = bounds(f), st = f.rec.style;
  f.timer = rand(5, 12); f.cruise = rand(0.28, 0.6); f.rest = 0;
  f.tx = rand(b.m, W - b.m); f.ty = rand(b.top, b.bot);
  if (st === 'bottom') {                     // 바닥에 붙어 짧게 옮겨 다닌다
    f.ty = sandY - b.ey * 0.45 + rand(0, 5); f.cruise = rand(0.2, 0.35);
    if (Math.abs(f.tx - f.x) > W * 0.45) f.tx = f.x + Math.sign(f.tx - f.x) * W * 0.4;
  } else if (st === 'rock') {                // 바위 둘레를 맴돈다
    const R = rockR();
    f.tx = clamp(SCENES[water].rockX * W + rand(-1.15, 1.15) * R, b.m, W - b.m);
    f.ty = clamp(rand(sandY - R * 1.5, sandY - b.ey - 4), b.top, b.bot); f.cruise = rand(0.15, 0.3);
  } else if (st === 'school') f.cruise = rand(0.6, 0.9);
  else if (st === 'upright') f.cruise = rand(0.08, 0.16);
}
function addFish(rec, img, fresh) {
  rec.style ||= guessStyle(rec.name); rec.water ||= guessWater(rec.name);
  const f = { rec, img, x: 0, y: 0, dir: 1, face: 1, vy: 0, go: 1, rest: 0, phase: rand(0, 6), depth: Math.random(), ox: rand(-1, 1), oy: rand(-0.5, 0.5) };
  fishes.push(f); fishes.sort((a, b) => a.depth - b.depth);
  if (fresh) water = rec.water;
  refreshShown();
  if (rec.water !== water) return;
  f.x = rand(W * 0.15, W * 0.85); f.y = rand(H * 0.2, sandY - 30);
  f.dir = f.face = Math.random() < 0.5 ? 1 : -1; retarget(f); if (rec.style === 'bottom') f.y = f.ty;
  if (fresh) {                                // 새로 넣은 물고기는 위에서 퐁당
    f.x = W / 2; f.y = -Math.max(fishH(f), fishL(f)) / 2;
    for (let i = 0; i < 14; i++) bubbles.push({ x: W / 2 + rand(-40, 40), y: rand(0, 60), r: rand(2, 6), v: rand(30, 70), s: rand(0, 6) });
  }
}
function placeAll() { for (const f of shown) { f.x = rand(W * 0.15, W * 0.85); f.y = rand(H * 0.2, sandY - 30); f.rest = 0; retarget(f); if (f.rec.style === 'bottom') f.y = f.ty; } }
function refreshShown() {
  shown = fishes.filter((f) => f.rec.water === water); rescale();
  const wn = water === 'sea' ? '바다' : '민물';
  $('empty').hidden = shown.length > 0;
  $('empty').firstChild.textContent = fishes.length ? `${wn} 어항에는 아직 물고기가 없어요` : '아직 물고기가 없어요';
  $('count').textContent = shown.length ? `${wn} · ${shown.length}마리` : `${wn} 어항`;
  document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.w === water));
  $('tagBtn').classList.toggle('on', showTags);
  $('timeBtn').textContent = `시간: ${{ auto: '자동', day: '낮', night: '밤' }[timeMode]}`;
}
function setWater(w) { if (w === water) return; water = w; setLS('aq-water', w); pellets.length = 0; bubbles.length = 0; refreshShown(); placeAll(); }
document.querySelectorAll('#seg button').forEach((b) => (b.onclick = () => setWater(b.dataset.w)));
$('tagBtn').onclick = () => { showTags = !showTags; setLS('aq-tags', showTags ? '1' : '0'); refreshShown(); };
$('timeBtn').onclick = () => { timeMode = { auto: 'day', day: 'night', night: 'auto' }[timeMode]; setLS('aq-time', timeMode); refreshShown(); };

// 지금이 낮(1)인지 밤(0)인지: 실제 시각 기준, 새벽·저녁에는 서서히 바뀐다
function daylight() {
  if (timeMode !== 'auto') return timeMode === 'day' ? 1 : 0;
  const d = new Date(), h = d.getHours() + d.getMinutes() / 60, sm = (v) => { v = clamp(v, 0, 1); return v * v * (3 - 2 * v); };
  return Math.min(sm((h - 5.5) / 1.5), sm((19.5 - h) / 1.5));
}

function stepFish(f, dt, t) {
  const st = f.rec.style, { up, L, hh, ey, m, top, bot } = bounds(f);
  // 먹이: 가장 가까운 알갱이로 달려간다 (바닥 물고기는 바닥 근처 먹이만)
  let food = null, bd = 1e9;
  for (const p of pellets) { if (st === 'bottom' && p.y < sandY - H * 0.2) continue; const d = Math.hypot(p.x - f.x, p.y - f.y); if (d < bd) { bd = d; food = p; } }
  if (food) {
    const hx = up ? f.x : f.x + f.face * L * 0.45, hy = up ? f.y - L * 0.45 : f.y;
    if (Math.hypot(food.x - hx, food.y - hy) < Math.max(12, hh * 0.3)) { pellets.splice(pellets.indexOf(food), 1); bubbles.push({ x: hx, y: hy, r: 2, v: 45, s: rand(0, 6) }); food = null; f.timer = 0.6; }
    else {
      f.rest = 0;
      if (!up && Math.abs(food.x - f.x) > L * 0.2) f.dir = food.x > f.x ? 1 : -1;
      f.tx = up ? food.x : food.x - f.dir * L * 0.45; f.ty = Math.min(up ? food.y + L * 0.45 : food.y, sandY - ey * 0.5);
    }
  }
  const chase = !!food;
  if (!chase && st === 'school' && f.rest <= 0) {
    const key = f.rec.name || f.rec.id; let g = groups.get(key);
    if (!g) groups.set(key, (g = { tx: W / 2, ty: H * 0.4, timer: 0 }));
    if (g.stamp !== t) { g.stamp = t; g.timer -= dt; if (g.timer < 0) { g.tx = g.tx < W / 2 ? rand(0.62, 0.9) * W : rand(0.1, 0.38) * W; g.ty = rand(H * 0.2, sandY - H * 0.22); g.timer = rand(4, 8); } }
    f.tx = clamp(g.tx + f.ox * L * 1.1, m, W - m); f.ty = clamp(g.ty + f.oy * L, top, bot);
  }
  const dx = f.tx - f.x, dy = f.ty - f.y, dist = Math.hypot(dx, dy);
  if (!chase && st !== 'school') {
    if (f.rest > 0) { f.rest -= dt; if (f.rest <= 0) retarget(f); }
    else if (dist < L * 0.3 + 6 || (f.timer -= dt) < 0) { if (dist >= L * 0.3 + 6) retarget(f); else if (st === 'bottom') f.rest = rand(4, 10); else if (st === 'rock') f.rest = rand(2, 6); else retarget(f); }
  }
  const resting = f.rest > 0 && !chase;
  f.go += ((resting ? 0 : 1) - f.go) * Math.min(1, dt * 2);
  if (!resting && Math.abs(dx) > (up ? 8 : L * 0.25)) f.dir = dx > 0 ? 1 : -1;
  f.face += (f.dir - f.face) * Math.min(1, dt * (chase ? 4.5 : 2.6));
  const base = Math.max(14, f.cruise * L) * (chase ? 2.4 : 1) * f.go;
  let v = base * (0.35 + 0.65 * Math.abs(f.face));
  if (chase || up) v *= clamp(Math.abs(dx) / (L * 0.3), 0, 1); else if (st === 'school') v *= clamp(dist / (L * 0.6), 0.15, 1);
  f.x += f.face * v * dt;
  const vm = base * (up || chase || st === 'bottom' ? 1 : 0.45), tvy = clamp(dy * (chase ? 2.2 : 0.6), -vm, vm);
  f.vy += (tvy - f.vy) * Math.min(1, dt * (chase ? 4 : 1.6)); f.y += f.vy * dt;
  f.phase += dt * (3.2 + 6 * f.cruise) * (0.3 + 0.7 * f.go) * (chase ? 1.8 : 1);
  ctx.globalAlpha = 0.84 + 0.16 * f.depth;
  const tilt = up ? Math.sin(t * 0.7 + f.depth * 9) * 0.07 : st === 'bottom' ? 0 : clamp(Math.atan2(f.vy, Math.max(v, 20)) * 0.7, -0.4, 0.4);
  drawFish(ctx, f.img, f.x, f.y + Math.sin(t * 0.8 + f.depth * 9) * 2 * f.go, L, f.face, tilt, f.phase, up, st === 'bottom' ? 0.5 : 1);
}

let last = 0;
function frame(now) {
  const t = now / 1000, dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
  const sc = SCENES[water], dTarget = daylight();
  dayCur = dayCur == null ? dTarget : dayCur + (dTarget - dayCur) * Math.min(1, dt * 1.4);
  const day = dayCur, dusk = 4 * day * (1 - day);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // 물
  const g = ctx.createLinearGradient(0, 0, 0, H);
  [0, 0.45, 1].forEach((p, i) => g.addColorStop(p, mix(sc.night[i], sc.day[i], day)));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // 햇살 (밤에는 희미한 달빛)
  ctx.globalCompositeOperation = 'lighter';
  const rayA = 0.035 + 0.1 * day;
  for (let i = 0; i < 6; i++) {
    const x = W * (i / 5) + Math.sin(t * 0.21 + i * 1.7) * W * 0.09, w = W * 0.07 * (1 + 0.35 * Math.sin(t * 0.33 + i * 2.1)), sl = H * 0.28;
    const rg = ctx.createLinearGradient(0, 0, 0, H * 0.85); rg.addColorStop(0, `rgba(190,240,255,${rayA})`); rg.addColorStop(1, 'rgba(190,240,255,0)');
    ctx.fillStyle = rg; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + w, 0); ctx.lineTo(x + w * 2.4 - sl, H * 0.85); ctx.lineTo(x - w - sl, H * 0.85); ctx.fill();
  }
  if (day < 0.98) {                            // 달
    const mg = ctx.createRadialGradient(W * 0.72, -10, 4, W * 0.72, -10, H * 0.55);
    mg.addColorStop(0, `rgba(200,220,255,${0.5 * (1 - day)})`); mg.addColorStop(0.12, `rgba(160,190,255,${0.16 * (1 - day)})`); mg.addColorStop(1, 'rgba(160,190,255,0)');
    ctx.fillStyle = mg; ctx.fillRect(0, 0, W, H);
  }
  if (dusk > 0.02) {                           // 노을
    const dg = ctx.createLinearGradient(0, 0, 0, H * 0.6); dg.addColorStop(0, `rgba(255,140,70,${0.3 * dusk})`); dg.addColorStop(1, 'rgba(255,140,70,0)');
    ctx.fillStyle = dg; ctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = 'source-over';
  // 수초
  ctx.lineCap = 'round';
  for (const wd of sc.weeds) {
    const x0 = wd.x * W, hgt = wd.h * H, K = 9;
    for (let k = 0; k < K; k++) {
      const a = k / K, b = (k + 1) / K;
      const xa = x0 + Math.sin(t * 0.9 + a * 3 + wd.seed) * a * a * sc.sway, xb = x0 + Math.sin(t * 0.9 + b * 3 + wd.seed) * b * b * sc.sway;
      ctx.strokeStyle = `hsl(${wd.hue} 55% ${16 + a * 16}%)`; ctx.lineWidth = wd.w * (1 - a * 0.75);
      ctx.beginPath(); ctx.moveTo(xa, sandY + 6 - a * hgt); ctx.lineTo(xb, sandY + 6 - b * hgt); ctx.stroke();
    }
  }
  // 수면의 연잎 (민물)
  for (const p of sc.pads) {
    const px = p.x * W + Math.sin(t * 0.4 + p.r) * 5;
    ctx.strokeStyle = 'rgba(20,60,40,.55)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, 4); ctx.quadraticCurveTo(px + 30, H * 0.5, px + 12, sandY + 4); ctx.stroke();
    ctx.fillStyle = 'rgba(14,52,34,.9)'; ctx.beginPath(); ctx.ellipse(px, 2, p.r, p.r * 0.3, 0, 0, 7); ctx.fill();
  }
  // 바위
  const R = rockR();
  for (const l of sc.lumps) {
    const cx = (sc.rockX + l.dx) * W, rw = R * l.w, rh = R * l.h;
    const rgd = ctx.createLinearGradient(0, sandY - rh, 0, sandY + 6); rgd.addColorStop(0, sc.rock[0]); rgd.addColorStop(1, sc.rock[1]);
    ctx.fillStyle = rgd; ctx.beginPath(); ctx.ellipse(cx, sandY + 6, rw, rh, 0, Math.PI, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.beginPath(); ctx.ellipse(cx - rw * 0.2, sandY + 6 - rh * 0.55, rw * 0.4, rh * 0.22, -0.3, 0, 7); ctx.fill();
  }
  // 바닥
  const sg = ctx.createLinearGradient(0, sandY - 10, 0, H); sg.addColorStop(0, sc.sand[0]); sg.addColorStop(1, sc.sand[1]);
  ctx.fillStyle = sg; ctx.beginPath(); ctx.moveTo(0, H);
  for (let x = 0; x <= W + 20; x += 20) ctx.lineTo(x, sandY + Math.sin(x * 0.013) * 7 + Math.sin(x * 0.041 + 2) * 3);
  ctx.lineTo(W, H); ctx.fill();
  for (const p of pebbles) { ctx.fillStyle = `rgb(${p.c},${p.c + 8},${p.c + 4})`; ctx.beginPath(); ctx.ellipse(p.x * W, sandY + 8 + p.y * (H - sandY - 8), p.r * 1.4, p.r, 0, 0, 7); ctx.fill(); }

  // 먹이
  ctx.fillStyle = '#c98a4a';
  for (let i = pellets.length - 1; i >= 0; i--) {
    const p = pellets[i];
    if (p.y < sandY + 2) { p.y += p.vy * dt; p.x += Math.sin(t * 2.2 + p.s) * 8 * dt; } else if ((p.life -= dt) < 0) { pellets.splice(i, 1); continue; }
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, 7); ctx.fill();
  }
  // 물고기
  for (const f of shown) stepFish(f, dt, t);
  ctx.globalAlpha = 1;

  // 공기방울
  if (Math.random() < dt * 2.2) { const src = sc.weeds[(Math.random() * 3) | 0].x * W; bubbles.push({ x: src + rand(-6, 6), y: sandY, r: rand(1.5, 4.5), v: rand(25, 60), s: rand(0, 6) }); }
  ctx.strokeStyle = 'rgba(220,245,255,.55)'; ctx.fillStyle = 'rgba(220,245,255,.12)'; ctx.lineWidth = 1;
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i]; b.y -= b.v * dt; const bx = b.x + Math.sin(t * 2 + b.s) * 4;
    if (b.y < -10) { bubbles.splice(i, 1); continue; }
    ctx.beginPath(); ctx.arc(bx, b.y, b.r, 0, 7); ctx.fill(); ctx.stroke();
  }
  // 밤에는 전체를 어둡게
  if (day < 0.99) { ctx.fillStyle = `rgba(2,8,26,${0.42 * (1 - day)})`; ctx.fillRect(0, 0, W, H); }
  // 이름표
  if (showTags) {
    ctx.font = '600 12px -apple-system, "Apple SD Gothic Neo", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of shown) {
      const b = bounds(f), txt = `${f.rec.name || '물고기'} ${f.rec.lengthCm}cm`, tw = ctx.measureText(txt).width + 14, ty = Math.max(70, f.y - b.ey - 14);
      ctx.fillStyle = 'rgba(4,20,38,.6)'; ctx.beginPath(); (ctx.roundRect ? ctx.roundRect(f.x - tw / 2, ty - 10, tw, 20, 10) : ctx.rect(f.x - tw / 2, ty - 10, tw, 20)); ctx.fill();
      ctx.fillStyle = '#eaf6ff'; ctx.fillText(txt, f.x, ty + 0.5);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  // 눈금자: 실제 크기 가늠용
  const unit = pxPerCm * 10 < 26 ? 50 : 10, bl = unit * pxPerCm, by = H - 24;
  ctx.strokeStyle = ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(16, by - 5); ctx.lineTo(16, by); ctx.lineTo(16 + bl, by); ctx.lineTo(16 + bl, by - 5); ctx.stroke();
  ctx.font = '12px sans-serif'; ctx.fillText(`${unit}cm`, 20 + bl, by + 2);
  requestAnimationFrame(frame);
}

// 물고기를 누르면 정보, 빈 물을 누르면 먹이
let down = null;
tank.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
tank.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) return;
  for (let i = shown.length - 1; i >= 0; i--) {
    const f = shown[i], b = bounds(f);
    if (Math.abs(e.clientX - f.x) < Math.max(b.ex, 26) && Math.abs(e.clientY - f.y) < Math.max(b.ey, 26)) return openSheet(f);
  }
  if (e.clientY < sandY - 10 && pellets.length < 60) for (let i = 0; i < 6; i++) pellets.push({ x: e.clientX + rand(-16, 16), y: e.clientY + rand(-8, 8), vy: rand(22, 40), s: rand(0, 6), life: 10 });
});

// ───────────────────────── 정보 카드
let cur = null;
function showFacts(r) {
  $('sTitle').textContent = r.name || '이름 없는 물고기';
  const rows = [`<span>길이</span>${r.lengthCm}cm`];
  rows.push(`<span>잡은 날</span>${dateText(r.date) || '기록 없음'}`);
  const where = r.place || (r.lat != null ? coordText(r) : '기록 없음');
  rows.push(`<span>잡은 곳</span>${escapeHtml(where)}${r.lat != null ? `<a href="${mapLink(r)}" target="_blank" rel="noopener">지도</a>` : ''}`);
  $('sFacts').innerHTML = rows.join('<br>');
  $('sMemo').textContent = r.memo || '';
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function openSheet(f) {
  cur = f; const r = f.rec;
  $('sPhoto').src = f.photoUrl ||= URL.createObjectURL(r.photo);
  showFacts(r); $('sView').hidden = false; $('sForm').hidden = true;
  $('sheet').hidden = $('sheetBg').hidden = false; $('sheet').scrollTop = 0;
  if (!r.place && r.lat != null && navigator.onLine) {     // 등록할 때 인터넷이 없었다면 지금 지명을 채운다
    const p = await placeName(r.lat, r.lon);
    if (p && !r.place) { r.place = p; await store('readwrite', (s) => s.put(r)); if (cur === f) showFacts(r); }
  }
}
function closeSheet() { $('sheet').hidden = $('sheetBg').hidden = true; cur = null; }
$('sClose').onclick = $('sheetBg').onclick = closeSheet;
$('sEdit').onclick = () => {
  const r = cur.rec; $('eName').value = r.name || ''; $('eLen').value = r.lengthCm; $('eDate').value = r.date || ''; $('ePlace').value = r.place || ''; $('eMemo').value = r.memo || ''; $('eWater').value = r.water; $('eStyle').value = r.style;
  $('sView').hidden = true; $('sForm').hidden = false;
};
$('eCancel').onclick = () => { $('sView').hidden = false; $('sForm').hidden = true; };
$('eSave').onclick = async () => {
  const len = parseFloat($('eLen').value); if (!(len > 0)) return toast('길이를 cm로 적어 주세요');
  const r = cur.rec; Object.assign(r, { name: $('eName').value.trim(), lengthCm: len, date: $('eDate').value, place: $('ePlace').value.trim(), memo: $('eMemo').value.trim(), water: $('eWater').value, style: $('eStyle').value });
  await store('readwrite', (s) => s.put(r)); const moved = r.water !== water; refreshShown(); if (moved) { closeSheet(); return toast('다른 어항으로 옮겼어요'); } cur.rest = 0; retarget(cur); showFacts(r); $('eCancel').onclick(); toast('저장했어요');
};
$('sDel').onclick = async () => {
  if (!confirm(`${cur.rec.name || '이 물고기'}를 어항에서 뺄까요?\n사진과 기록이 함께 지워져요.`)) return;
  await store('readwrite', (s) => s.delete(cur.rec.id));
  fishes.splice(fishes.indexOf(cur), 1); refreshShown(); closeSheet();
};

// 도감
$('bookBtn').onclick = () => {
  const g = $('bookGrid'); g.innerHTML = '';
  if (!fishes.length) g.innerHTML = '<div class="note" style="grid-column:1/-1;text-align:center;margin-top:40px">아직 기록이 없어요</div>';
  [...fishes].sort((a, b) => (b.rec.date || '').localeCompare(a.rec.date || '')).forEach((f) => {
    const b = document.createElement('button'); b.className = 'card';
    const img = document.createElement('img'); img.src = f.img.src; b.append(img);
    const n = document.createElement('b'); n.textContent = `${f.rec.name || '물고기'} · ${f.rec.lengthCm}cm`; b.append(n);
    const s = document.createElement('small'); s.textContent = [dateText(f.rec.date), f.rec.place].filter(Boolean).join(' · ') || '기록 없음'; b.append(s);
    b.onclick = () => { $('book').hidden = true; setWater(f.rec.water); openSheet(f); }; g.append(b);
  });
  $('book').hidden = false;
};
$('bookClose').onclick = () => ($('book').hidden = true);

// ───────────────────────── 사진에서 물고기 오려내기
let segP = null;
function getSeg() {
  return (segP ??= (async () => {
    const { InteractiveSegmenter, FilesetResolver } = await import('./vendor/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks(new URL('./vendor/wasm', location.href).href);
    return InteractiveSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL('./vendor/magic_touch.tflite', location.href).href, delegate: 'CPU' },
      outputCategoryMask: false, outputConfidenceMasks: true,
    });
  })().catch((e) => { segP = null; throw e; }));
}

const E = { mode: 'select' };   // 편집 중인 사진 상태
const cPhoto = $('cPhoto'), cMask = $('cMask'), mctx = cMask.getContext('2d');
const HINTS = {
  select: '물고기 몸통을 머리부터 꼬리까지 손가락으로 쓱 그어 주세요',
  erase: '손·배경처럼 물고기가 아닌 곳을 문질러 지워요',
  restore: '잘려 나간 지느러미·꼬리를 문질러 되살려요',
};
function setMode(m) {
  E.mode = m; $('cutHint').textContent = HINTS[m];
  document.querySelectorAll('.tools .btn').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
}
document.querySelectorAll('.tools .btn').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

function fitStage() {
  if ($('cut').hidden || !E.W) return;
  const st = $('stage'), k = Math.min((st.clientWidth - 16) / E.W, (st.clientHeight - 8) / E.H);
  $('wrap').style.width = E.W * k + 'px'; $('wrap').style.height = E.H * k + 'px';
}
addEventListener('resize', fitStage);

$('addBtn').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  try {
    const img = await loadImg(file);
    const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    E.W = Math.round(img.naturalWidth * k); E.H = Math.round(img.naturalHeight * k);
    cPhoto.width = cMask.width = E.W; cPhoto.height = cMask.height = E.H;
    cPhoto.getContext('2d').drawImage(img, 0, 0, E.W, E.H); URL.revokeObjectURL(img.src);
    E.mask = new Float32Array(E.W * E.H); E.over = mctx.createImageData(E.W, E.H); E.has = false;
    E.meta = readExif(await file.slice(0, 600000).arrayBuffer());
    E.place = null; E.formReady = false;
    if (E.meta.lat != null) E.place = placeName(E.meta.lat, E.meta.lon);   // 미리 찾아 둔다
    mctx.clearRect(0, 0, E.W, E.H); $('cutNext').disabled = true; setMode('select');
    $('cut').hidden = false; fitStage();
    getSeg().catch(() => toast('오려내기 준비에 실패했어요. 인터넷을 확인하고 다시 열어 주세요', 5000));
  } catch { toast('이 사진은 열 수 없어요. 다른 사진으로 해 보세요'); }
};
$('cutCancel').onclick = () => ($('cut').hidden = true);

function paintOverlay(x0 = 0, y0 = 0, x1 = E.W, y1 = E.H) {
  const d = E.over.data, W_ = E.W;
  for (let y = y0; y < y1; y++) for (let x = x0, i = y * W_ + x0; x < x1; x++, i++) {
    const a = E.mask[i], o = i * 4; d[o] = 0; d[o + 1] = 12; d[o + 2] = 30; d[o + 3] = E.has ? (1 - a) * 185 : 0;
  }
  mctx.putImageData(E.over, 0, 0, x0, y0, x1 - x0, y1 - y0);
}
const evPos = (e) => { const r = cMask.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * E.W, y: (e.clientY - r.top) / r.height * E.H }; };

let stroke = null;
cMask.addEventListener('pointerdown', (e) => {
  if (E.busy) return; cMask.setPointerCapture(e.pointerId);
  const p = evPos(e); stroke = [p];
  if (E.mode !== 'select') brushAt(p);
});
cMask.addEventListener('pointermove', (e) => {
  if (!stroke) return; const p = evPos(e), q = stroke[stroke.length - 1];
  if (E.mode === 'select') {
    stroke.push(p);
    mctx.strokeStyle = '#5fe0ff'; mctx.lineWidth = Math.max(4, E.W / 110); mctx.lineCap = 'round';
    mctx.beginPath(); mctx.moveTo(q.x, q.y); mctx.lineTo(p.x, p.y); mctx.stroke();
  } else {
    const n = Math.ceil(Math.hypot(p.x - q.x, p.y - q.y) / 4) || 1;
    for (let i = 1; i <= n; i++) brushAt({ x: q.x + (p.x - q.x) * i / n, y: q.y + (p.y - q.y) * i / n });
    stroke = [p];
  }
});
const endStroke = () => { const s = stroke; stroke = null; if (s && E.mode === 'select') runSegment(s); };
cMask.addEventListener('pointerup', endStroke); cMask.addEventListener('pointercancel', endStroke);

function brushAt(p) {
  const r = +$('brush').value * E.W / cMask.getBoundingClientRect().width, erase = E.mode === 'erase';
  const x0 = Math.max(0, Math.floor(p.x - r)), x1 = Math.min(E.W, Math.ceil(p.x + r)), y0 = Math.max(0, Math.floor(p.y - r)), y1 = Math.min(E.H, Math.ceil(p.y + r));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const d = Math.hypot(x - p.x, y - p.y) / r; if (d >= 1) continue;
    const f = clamp((1 - d) * 4, 0, 1), i = y * E.W + x;
    E.mask[i] = erase ? Math.min(E.mask[i], 1 - f) : Math.max(E.mask[i], f);
  }
  if (!erase) { E.has = true; $('cutNext').disabled = false; }
  paintOverlay(x0, y0, x1, y1);
}

async function runSegment(pts) {
  E.busy = true; $('busy').hidden = false;
  try {
    const seg = await getSeg();
    await new Promise((r) => setTimeout(r, 30));           // '찾는 중' 글자가 먼저 보이게
    const step = Math.max(1, Math.floor(pts.length / 24)), use = pts.filter((_, i) => i % step === 0);
    const norm = use.map((p) => ({ x: clamp(p.x / E.W, 0, 1), y: clamp(p.y / E.H, 0, 1) }));
    const roi = norm.length > 2 ? { scribble: norm } : { keypoint: norm[0] };
    let conf = null, mw = 0, mh = 0;
    seg.segment(cPhoto, roi, (res) => {
      const ms = res.confidenceMasks; mw = ms[0].width; mh = ms[0].height;
      const arrs = ms.map((m) => m.getAsFloat32Array());
      // 어느 쪽이 '고른 것'인지: 손가락이 지나간 자리의 값이 큰 쪽
      const score = (a) => norm.reduce((s, p) => s + a[Math.min(mh - 1, (p.y * mh) | 0) * mw + Math.min(mw - 1, (p.x * mw) | 0)], 0) / norm.length;
      const sc = arrs.map(score), best = sc.indexOf(Math.max(...sc));
      conf = Float32Array.from(arrs[best]);
      if (arrs.length === 1 && sc[0] < 0.5) for (let i = 0; i < conf.length; i++) conf[i] = 1 - conf[i];
    });
    // 화면 크기로 늘리고, 손가락이 닿은 덩어리만 남긴다
    const W_ = E.W, H_ = E.H, big = new Float32Array(W_ * H_);
    for (let y = 0; y < H_; y++) {
      const fy = clamp((y + 0.5) / H_ * mh - 0.5, 0, mh - 1), y0 = fy | 0, y1 = Math.min(mh - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < W_; x++) {
        const fx = clamp((x + 0.5) / W_ * mw - 0.5, 0, mw - 1), x0 = fx | 0, x1 = Math.min(mw - 1, x0 + 1), wx = fx - x0;
        big[y * W_ + x] = (conf[y0 * mw + x0] * (1 - wx) + conf[y0 * mw + x1] * wx) * (1 - wy) + (conf[y1 * mw + x0] * (1 - wx) + conf[y1 * mw + x1] * wx) * wy;
      }
    }
    const seen = new Uint8Array(W_ * H_), q = new Int32Array(W_ * H_); let qh = 0, qt = 0;
    for (const p of pts) { const i = clamp(p.y | 0, 0, H_ - 1) * W_ + clamp(p.x | 0, 0, W_ - 1); if (big[i] > 0.4 && !seen[i]) { seen[i] = 1; q[qt++] = i; } }
    while (qh < qt) {
      const i = q[qh++], x = i % W_;
      for (const j of [x > 0 ? i - 1 : -1, x < W_ - 1 ? i + 1 : -1, i - W_, i + W_]) if (j >= 0 && j < seen.length && !seen[j] && big[j] > 0.4) { seen[j] = 1; q[qt++] = j; }
    }
    if (qt < 300) { toast('물고기를 못 찾았어요. 몸통 한가운데를 다시 그어 주세요'); paintOverlay(); return; }
    for (let i = 0; i < big.length; i++) E.mask[i] = seen[i] ? clamp((big[i] - 0.4) / 0.2, 0, 1) : 0;
    E.has = true; $('cutNext').disabled = false; paintOverlay();
    $('cutHint').textContent = '밝게 남은 부분이 물고기예요. 틀리면 다시 긋거나 지우기·되살리기로 다듬어요';
  } catch (err) { console.error(err); toast('오려내기에 실패했어요. 다시 시도해 주세요'); paintOverlay(); }
  finally { E.busy = false; $('busy').hidden = true; }
}

// 오려낸 물고기를 수평으로 눕히고(몸통 방향 계산) 머리가 왼쪽을 보게 맞춘다
function buildCutout() {
  const { W: W_, H: H_, mask } = E;
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < H_; y++) for (let x = 0; x < W_; x++) if (mask[y * W_ + x] > 0.5) { n++; sx += x; sy += y; }
  if (n < 300) return null;
  const cx = sx / n, cy = sy / n; let xx = 0, yy = 0, xy = 0;
  for (let y = 0; y < H_; y += 2) for (let x = 0; x < W_; x += 2) if (mask[y * W_ + x] > 0.5) { const dx = x - cx, dy = y - cy; xx += dx * dx; yy += dy * dy; xy += dx * dy; }
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
  const c = makeCanvas(W_, H_), cc = c.getContext('2d'); cc.drawImage(cPhoto, 0, 0);
  const id = cc.getImageData(0, 0, W_, H_); for (let i = 0; i < mask.length; i++) id.data[i * 4 + 3] = mask[i] * 255; cc.putImageData(id, 0, 0);
  const D = Math.ceil(Math.hypot(W_, H_)) + 4, r = makeCanvas(D, D), rc = r.getContext('2d');
  rc.translate(D / 2, D / 2); rc.rotate(-theta); rc.drawImage(c, -cx, -cy);
  const rd = rc.getImageData(0, 0, D, D).data; let x0 = D, x1 = 0, y0 = D, y1 = 0;
  for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) if (rd[(y * D + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, k = Math.min(1, 720 / bw);
  const out = makeCanvas(bw * k, bh * k), oc = out.getContext('2d');
  // 몸의 무게중심은 머리 쪽에 치우쳐 있다 → 중심이 오른쪽이면 좌우를 뒤집는다
  if (D / 2 > (x0 + x1) / 2) { oc.translate(out.width, 0); oc.scale(-1, 1); }
  oc.drawImage(r, x0, y0, bw, bh, 0, 0, out.width, out.height);
  return out;
}
function flipCut(h) {
  const s = E.cut, o = makeCanvas(s.width, s.height), oc = o.getContext('2d');
  oc.translate(h ? s.width : 0, h ? 0 : s.height); oc.scale(h ? -1 : 1, h ? 1 : -1); oc.drawImage(s, 0, 0); E.cut = o;
}
$('flipH').onclick = () => flipCut(true); $('flipV').onclick = () => flipCut(false);

$('cutNext').onclick = async () => {
  E.cut = buildCutout(); if (!E.cut) return toast('물고기가 너무 작게 골라졌어요');
  $('cut').hidden = true; $('info').hidden = false;
  if (!E.formReady) {
    E.formReady = true; const m = E.meta;
    $('fName').value = ''; $('fWater').value = E.baseWater = water; $('fStyle').value = 'normal'; E.touched = false; $('fLen').value = ''; $('fMemo').value = ''; $('fPlace').value = '';
    const today = new Date(), iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    $('fDate').value = m.date || iso;
    const bits = [m.date ? `사진에 기록된 날짜: ${dateText(m.date)}` : '사진에 날짜 정보가 없어 오늘 날짜로 넣었어요. 다르면 고쳐 주세요.'];
    bits.push(m.lat != null ? `사진에 기록된 위치: ${coordText(m)}` : '사진에 위치 정보가 없어요. 잡은 곳은 직접 적어 주세요.');
    $('fMeta').textContent = bits.join(' / ');
    if (E.place) E.place.then((p) => { if (p && !$('fPlace').value) $('fPlace').value = p; });
  }
  previewLoop();
};
// 어종 이름을 적으면 헤엄 방식·사는 물을 미리 골라 준다 (직접 바꾼 뒤에는 건드리지 않음)
$('fName').oninput = () => { if (E.touched) return; const n = $('fName').value; $('fStyle').value = guessStyle(n); $('fWater').value = FRESH_GUESS.test(n) ? 'fresh' : STYLE_GUESS.some(([re]) => re.test(n)) ? 'sea' : E.baseWater; };
$('fWater').onchange = $('fStyle').onchange = () => (E.touched = true);
$('infoBack').onclick = () => { $('info').hidden = true; $('cut').hidden = false; fitStage(); };

function previewLoop(now = 0) {
  if ($('info').hidden) return;
  const c = $('preview'), w = c.clientWidth, h = c.clientHeight, d = Math.min(2, devicePixelRatio || 1);
  if (c.width !== Math.round(w * d)) { c.width = Math.round(w * d); c.height = Math.round(h * d); }
  const p = c.getContext('2d'); p.setTransform(d, 0, 0, d, 0, 0);
  const g = p.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#2a9fd0'); g.addColorStop(1, '#0a3e6b'); p.fillStyle = g; p.fillRect(0, 0, w, h);
  const L = Math.min(w * 0.78, (h * 0.72) * E.cut.width / E.cut.height);
  drawFish(p, E.cut, w / 2, h / 2, L, -1, 0, now / 1000 * 5.5);
  requestAnimationFrame(previewLoop);
}

$('infoSave').onclick = async () => {
  const len = parseFloat($('fLen').value);
  if (!(len > 0)) { $('fLen').focus(); return toast('길이를 cm로 적어 주세요. 실제 크기로 헤엄쳐요'); }
  $('infoSave').disabled = true;
  try {
    const rec = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: $('fName').value.trim(), lengthCm: len,
      date: $('fDate').value, place: $('fPlace').value.trim(), memo: $('fMemo').value.trim(), water: $('fWater').value, style: $('fStyle').value,
      lat: E.meta.lat ?? null, lon: E.meta.lon ?? null, createdAt: Date.now(),
      cutout: await toBlob(E.cut, 'image/png'), photo: await toBlob(cPhoto, 'image/jpeg', 0.85),
    };
    await store('readwrite', (s) => s.put(rec));
    setWater(rec.water); addFish(rec, await loadImg(rec.cutout), true);
    $('info').hidden = true; toast(`${rec.name || '물고기'}가 어항에 들어갔어요`);
  } catch (err) { console.error(err); toast('저장에 실패했어요. 폰 저장 공간을 확인해 주세요', 4000); }
  finally { $('infoSave').disabled = false; }
};

// ───────────────────────── 시작
resize(); requestAnimationFrame(frame);
(async () => {
  try {
    const all = await store('readonly', (s) => s.getAll());
    for (const rec of all) addFish(rec, await loadImg(rec.cutout), false);
  } catch (err) { console.error(err); toast('저장된 물고기를 불러오지 못했어요'); }
  refreshShown();
  navigator.storage?.persist?.();                         // 폰이 기록을 멋대로 지우지 않게 요청
})();

// 화면 꺼짐 방지 (어항을 켜 두고 볼 수 있게)
const keepAwake = () => { if (document.visibilityState === 'visible') navigator.wakeLock?.request('screen').catch(() => {}); };
document.addEventListener('visibilitychange', keepAwake); keepAwake();

// 인터넷 없이도 열리게 (홈 화면 앱)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
