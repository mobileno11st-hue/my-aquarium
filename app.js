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
let yearSel = LS('aq-year', 'all');   // 'all' | '2025' 같은 연도 | 'none'(날짜 없음)
const yearOf = (rec) => (/^\d{4}/.exec(rec.date || '') || ['none'])[0];
const yearName = (y) => (y === 'all' ? '전체' : y === 'none' ? '날짜 없음' : `${y}년`);
let water = LS('aq-water', 'sea'), showTags = LS('aq-tags', '0') === '1', timeMode = LS('aq-time', 'day'), dayCur = null;

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
    day: ['#a9e4ee', '#4aa9cc', '#17608c'], night: ['#0b2f55', '#061c38', '#020b1a'], sand: ['#e6dab0', '#8d8463'], rock: ['#8e9aa2', '#3b4650'], rockX: 0.8, sway: 26,
    lumps: [{ dx: -0.1, w: 0.6, h: 0.5 }, { dx: 0.02, w: 0.8, h: 1 }, { dx: 0.13, w: 0.55, h: 0.6 }],
    weeds: Array.from({ length: 8 }, (_, i) => ({ x: (i + rand(0.2, 0.8)) / 8, h: rand(0.12, 0.3), seed: rand(0, 9), hue: rand(95, 150), w: rand(5, 10) })),
    pads: [],
  },
  fresh: {
    day: ['#b4dcb4', '#4d9a7c', '#1a5044'], night: ['#143a34', '#0a2422', '#030e0e'], sand: ['#7d7355', '#38382a'], rock: ['#77775f', '#2c2e26'], rockX: 0.22, sway: 9,
    lumps: [{ dx: -0.07, w: 0.75, h: 0.5 }, { dx: 0.07, w: 0.5, h: 0.75 }],
    weeds: Array.from({ length: 18 }, (_, i) => ({ x: (i + rand(0.1, 0.9)) / 18, h: rand(0.2, 0.52), seed: rand(0, 9), hue: rand(65, 110), w: rand(2.5, 5) })),
    pads: Array.from({ length: 5 }, (_, i) => ({ x: (i + rand(0.2, 0.8)) / 5, r: rand(22, 40) })),
  },
};
const rockR = () => Math.min(W, H) * 0.2;
let surfY = 20;
// 물결이 만드는 빛 그물 무늬: 한 번 그려 두고 흘려보낸다 (이어 붙여도 티가 안 나게 만든다)
function makeCaustic(seed) {
  const N = 256, c = makeCanvas(N, N), cx = c.getContext('2d'), id = cx.createImageData(N, N), k = Math.PI * 2 / N;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const wx = x + 14 * Math.sin(k * y * 2 + seed), wy = y + 14 * Math.sin(k * x * 2 + seed * 1.7);
    const s = Math.sin(k * (wx * 3 + wy) + seed) + Math.sin(k * (wy * 3 - wx * 2) + seed * 2.1) + Math.sin(k * (wx - wy * 4) + seed * 0.7);
    const o = (y * N + x) * 4; id.data[o] = 235; id.data[o + 1] = 250; id.data[o + 2] = 255; id.data[o + 3] = Math.pow(Math.max(0, 1 - Math.abs(s) / 1.1), 5) * 255;
  }
  cx.putImageData(id, 0, 0); return c;
}
const caus1 = makeCaustic(1.3), caus2 = makeCaustic(4.1);
function drawCaustic(tex, ox, oy, size, sy, x0, y0, x1, y1) {
  const th = size * sy; ox = ((ox % size) + size) % size; oy = ((oy % th) + th) % th;
  for (let y = y0 - oy; y < y1; y += th) for (let x = x0 - ox; x < x1; x += size) ctx.drawImage(tex, x, y, size + 0.5, th + 0.5);
}
const sandLine = (x) => sandY + Math.sin(x * 0.013) * 7 + Math.sin(x * 0.041 + 2) * 3;
function sandPath() { ctx.beginPath(); ctx.moveTo(0, H); for (let x = 0; x <= W + 20; x += 20) ctx.lineTo(x, sandLine(x)); ctx.lineTo(W, H); }
const motes = Array.from({ length: 40 }, () => ({ x: Math.random(), y: Math.random(), r: rand(0.5, 1.5), s: rand(0, 6), v: rand(0.004, 0.012) }));
const bubbles = [], pellets = [], groups = new Map();
const pebbles = Array.from({ length: 26 }, () => ({ x: Math.random(), y: rand(0.2, 0.9), r: rand(2, 7), c: rand(60, 120) }));

function resize() {
  DPR = Math.min(dprCap, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  tank.width = Math.round(W * DPR); tank.height = Math.round(H * DPR); glc.width = hudc.width = tank.width; glc.height = hudc.height = tank.height;
  sandY = H * 0.88; surfY = Math.max(16, $('count').getBoundingClientRect().top - 7); rescale();
  // 화면 크기가 바뀌면(폰을 돌릴 때 등) 물고기를 새 화면 안으로 불러들인다
  for (const f of shown) { f.x = clamp(f.x, 0, W); f.y = clamp(f.y, 0, sandY); f.rest = 0; retarget(f); }
  groups.clear();
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
  if (fresh) { water = rec.water; if (yearSel !== 'all') yearSel = yearOf(rec); }
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
  if (yearSel !== 'all' && fishes.length && !fishes.some((f) => yearOf(f.rec) === yearSel)) yearSel = 'all';   // 그 해 물고기가 다 빠졌으면 전체로
  shown = fishes.filter((f) => f.rec.water === water && (yearSel === 'all' || yearOf(f.rec) === yearSel)); rescale();
  const wn = water === 'sea' ? '바다' : '민물', yn = yearSel === 'all' ? '' : yearName(yearSel) + ' ';
  $('empty').hidden = shown.length > 0;
  $('empty').firstChild.textContent = fishes.length ? `${yn}${wn} 어항에는 아직 물고기가 없어요` : '아직 물고기가 없어요';
  $('countText').textContent = `${yearName(yearSel)} · ${shown.length}마리`;
  document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.w === water));
  $('tagBtn').classList.toggle('on', showTags);
  $('timeVal').textContent = { auto: '자동', day: '낮', night: '밤' }[timeMode];
}
function setWater(w) { if (w === water) return; water = w; decoSel = null; syncDecoCtl(); setLS('aq-water', w); pellets.length = 0; bubbles.length = 0; refreshShown(); placeAll(); }
document.querySelectorAll('#seg button').forEach((b) => (b.onclick = () => setWater(b.dataset.w)));
// 연도별 어항: 왼쪽 위 칸을 누르면 연도를 고른다
function setYear(y) { yearSel = y; setLS('aq-year', y); pellets.length = 0; refreshShown(); placeAll(); }
$('count').onclick = () => {
  const m = $('yearMenu'); $('menu').hidden = true;
  if (!m.hidden) return (m.hidden = true);
  const here = fishes.filter((f) => f.rec.water === water), cnt = {};
  for (const f of here) cnt[yearOf(f.rec)] = (cnt[yearOf(f.rec)] || 0) + 1;
  const ys = Object.keys(cnt).filter((y) => y !== 'none').sort().reverse(); if (cnt.none) ys.push('none');
  m.innerHTML = '';
  for (const y of ['all', ...ys]) {
    const b = document.createElement('button'); b.className = y === yearSel ? 'on' : '';
    const s = document.createElement('span'); s.textContent = yearName(y); const e = document.createElement('em'); e.textContent = `${y === 'all' ? here.length : cnt[y]}마리`;
    b.append(s, e); b.onclick = () => { m.hidden = true; setYear(y); }; m.append(b);
  }
  m.hidden = false;
};
tank.addEventListener('pointerdown', () => ($('yearMenu').hidden = true));
// 햄버거 메뉴: 도감·꾸미기·사용법은 누르면 닫히고, 이름표·시간은 열린 채로 바뀐다
$('menuBtn').onclick = () => { $('yearMenu').hidden = true; $('menu').hidden = !$('menu').hidden; };
$('menu').addEventListener('click', (e) => { if (e.target.closest('#bookBtn, #decoBtn, #helpBtn')) $('menu').hidden = true; });
tank.addEventListener('pointerdown', () => ($('menu').hidden = true));
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

// ───────────────────────── 진짜 같은 물: 그래픽카드(WebGL)로 굴절·빛 그물·빛줄기를 실시간 계산
// 2D로 그린 장면(물고기·수초·바위·모래)을 통째로 넘겨받아 물속에 넣은 것처럼 합성한다. 안 되는 기기는 기존 그림으로 표시.
const glc = document.createElement('canvas'), hudc = document.createElement('canvas'), hctx = hudc.getContext('2d');
for (const c of [glc, hudc]) c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;pointer-events:none';
let G = null, dprCap = 2, slowAcc = 0, slowN = 0;
const VS = 'attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }';
const FS = `precision highp float;
varying vec2 vUv;
uniform sampler2D uTex; uniform vec2 uRes; uniform float uTime, uDay, uDusk, uSurf, uSand; uniform vec3 uC0, uC1, uC2;
float hash(float n){ return fract(sin(n) * 43758.5453123); }
float n1(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash(i), hash(i + 1.0), f); }
// 수면 물결이 빛을 모아 만드는 그물 무늬
float caustic(vec2 uv, float time){
  vec2 p = mod(uv * 6.28318530718, 6.28318530718) - 250.0; vec2 i = p; float c = 1.0; const float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float t = time * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 4.0; c = 1.17 - pow(c, 1.4); return pow(abs(c), 8.0);
}
void main(){
  vec2 uv = vUv; float asp = uRes.x / uRes.y, t = uTime, fx = uv.x * asp;
  float surf = uSurf + sin(fx * 22.0 + t * 1.6) * 0.0026 + sin(fx * 51.0 - t * 2.3) * 0.0015;
  float depth = clamp((uv.y - surf) / (1.0 - surf), 0.0, 1.0);
  float lightK = 0.12 + 0.88 * uDay;
  // 물빛: 위는 밝고 아래로 갈수록 깊어진다
  vec3 col = mix(uC0, uC1, smoothstep(0.0, 0.45, depth)); col = mix(col, uC2, smoothstep(0.45, 1.0, depth));
  // 물 건너편에 초점이 나간 듯 흐릿한 바위 (깊이감)
  float h1 = 0.64 - 0.12 * n1(fx * 2.3 + 3.0) - 0.04 * n1(fx * 7.0 + 1.0);
  col = mix(col, uC2 * 0.92, smoothstep(h1, h1 + 0.05, uv.y) * 0.30);
  float h2 = 0.76 - 0.10 * n1(fx * 3.1 + 11.0) - 0.03 * n1(fx * 9.0 + 5.0);
  col = mix(col, uC2 * 0.80, smoothstep(h2, h2 + 0.035, uv.y) * 0.38);
  // 수면 위 조명에서 퍼져 내려오는 빛줄기
  vec2 d = vec2(fx, uv.y) - vec2(0.30 * asp, -0.35); float ang = atan(d.x, d.y);
  float r = n1(ang * 26.0 + t * 0.22) * n1(ang * 57.0 - t * 0.31 + 7.0);
  r = smoothstep(0.18, 0.75, r) * (1.0 - smoothstep(0.0, 0.95, depth)) * (0.6 + 0.4 * n1(ang * 9.0 + t * 0.1));
  vec3 rayCol = vec3(0.80, 0.96, 1.0) * r * 0.34 * lightK;
  col += rayCol;
  // 수면 바로 아래: 밝게 번지는 빛과 일렁이는 물결 그림자
  float sh = caustic(vec2(fx * 1.4 + t * 0.02, depth * 9.0), t * 0.55);
  col += vec3(0.85, 0.97, 1.0) * (exp(-depth * 10.0) * (0.10 + 0.30 * lightK) + sh * exp(-depth * 16.0) * 0.55 * lightK);
  col += vec3(0.55, 0.65, 1.0) * (1.0 - uDay) * 0.22 * exp(-length(vec2(fx - 0.72 * asp, uv.y)) * 3.5);   // 달빛
  col += vec3(1.0, 0.52, 0.25) * uDusk * 0.28 * exp(-depth * 3.0);                                          // 노을
  // 물고기·수초·바닥: 물에 굴절되어 살짝 일렁이고, 빛 그물이 그 위로 흐른다
  vec2 wob = vec2(sin(uv.y * 42.0 + t * 1.25) + sin(uv.y * 19.0 - t * 0.85 + uv.x * 8.0), cos(fx * 34.0 + t * 1.05)) * 0.0011 * smoothstep(0.0, 0.03, depth);
  vec4 L = texture2D(uTex, uv + wob);
  float fl = smoothstep(uSand - 0.012, uSand + 0.02, uv.y);
  float ca = caustic(mix(vec2(fx, uv.y) * 1.9, vec2(fx * 2.6, (uv.y - uSand) * 9.0), fl), t * 0.5);
  vec3 lit = L.rgb * (mix(0.92, 0.80, fl) + ca * mix(0.55, 1.25, fl) * lightK);
  lit = mix(lit, col * L.a, (0.06 + 0.16 * depth) * (1.0 - fl));
  col = lit + col * (1.0 - L.a);
  col += rayCol * L.a * 0.5;
  // 수면 선과 그 위 수조 덮개 그늘
  float above = 1.0 - smoothstep(surf - 0.0015, surf + 0.0015, uv.y);
  vec3 hood = mix(vec3(0.02, 0.06, 0.09), mix(vec3(0.04, 0.11, 0.16), vec3(0.16, 0.35, 0.42), uDay), uv.y / max(surf, 0.001));
  col = mix(col, hood, above);
  col += vec3(0.95, 1.0, 1.0) * (1.0 - smoothstep(0.0, 0.0028, abs(uv.y - surf))) * (0.3 + 0.6 * uDay);
  col *= mix(0.62, 1.0, uDay);
  // 유리 수조: 가장자리 그늘, 비스듬한 유리 반사
  vec2 q = uv - vec2(0.5, 0.48); col *= 1.0 - dot(q, q) * 0.75;
  float gs = fx + uv.y * 0.6; col += vec3(1.0) * smoothstep(0.16, 0.24, gs) * (1.0 - smoothstep(0.28, 0.36, gs)) * 0.035;
  gl_FragColor = vec4(col, 1.0);
}`;
function initGL() {
  try {
    const g = glc.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'high-performance' }); if (!g) return;
    const sh = (type, src) => { const s = g.createShader(type); g.shaderSource(s, src); g.compileShader(s); if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s)); return s; };
    const p = g.createProgram(); g.attachShader(p, sh(g.VERTEX_SHADER, VS)); g.attachShader(p, sh(g.FRAGMENT_SHADER, FS)); g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p));
    g.useProgram(p);
    g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer()); g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
    const loc = g.getAttribLocation(p, 'aPos'); g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
    g.bindTexture(g.TEXTURE_2D, g.createTexture());
    for (const [k, v] of [[g.TEXTURE_MIN_FILTER, g.LINEAR], [g.TEXTURE_MAG_FILTER, g.LINEAR], [g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE]]) g.texParameteri(g.TEXTURE_2D, k, v);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    const U = {}; for (const n of ['uTex', 'uRes', 'uTime', 'uDay', 'uDusk', 'uSurf', 'uSand', 'uC0', 'uC1', 'uC2']) U[n] = g.getUniformLocation(p, n);
    G = { g, U };
    tank.before(glc); tank.after(hudc); tank.style.opacity = '0';   // 2D 그림은 보이지 않게 두고 터치만 받는다
    glc.addEventListener('webglcontextlost', (e) => { e.preventDefault(); G = null; tank.style.opacity = '1'; glc.remove(); hudc.remove(); });
  } catch (err) { console.warn('WebGL을 쓸 수 없어 기본 그림으로 표시합니다', err); G = null; }
}
function glRender(t, day, dusk, sc) {
  const { g, U } = G;
  g.viewport(0, 0, glc.width, glc.height);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, tank);
  const c = (i) => { const A = hex(sc.night[i]), B = hex(sc.day[i]); return A.map((v, k) => (v + (B[k] - v) * day) / 255); };
  g.uniform1i(U.uTex, 0); g.uniform2f(U.uRes, glc.width, glc.height); g.uniform1f(U.uTime, t % 900);
  g.uniform1f(U.uDay, day); g.uniform1f(U.uDusk, dusk); g.uniform1f(U.uSurf, surfY / H); g.uniform1f(U.uSand, sandY / H);
  g.uniform3fv(U.uC0, c(0)); g.uniform3fv(U.uC1, c(1)); g.uniform3fv(U.uC2, c(2));
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
}
initGL();


// ───────────────────────── 어항 꾸미기: 바닥에 놓는 장식 (그림은 모두 직접 그린다. 원점 = 바닥에 닿는 가운데, u = 기준 크기)
const TAU = Math.PI * 2;
const sr = (seed, k) => { const v = Math.sin(seed * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); };   // 씨앗값으로 만드는 고정 난수
const DECO = {
  weed: { n: '해초', d(c, u, t, s) {
    c.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const h = u * (1.1 + sr(s, i) * 0.9), x0 = (i - 1.5) * u * 0.13, K = 8;
      for (let k = 0; k < K; k++) {
        const a = k / K, b = (k + 1) / K, sw = (q) => x0 + Math.sin(t * 0.9 + q * 3 + s + i) * q * q * u * 0.3;
        c.strokeStyle = `hsl(${112 + i * 10} 52% ${17 + a * 17}%)`; c.lineWidth = u * 0.1 * (1 - a * 0.7);
        c.beginPath(); c.moveTo(sw(a), -a * h); c.lineTo(sw(b), -b * h); c.stroke();
      }
    }
  } },
  kelp: { n: '다시마', d(c, u, t, s) {
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (let i = 0; i < 2; i++) {
      const h = u * (1.7 + sr(s, i) * 0.7), x0 = (i - 0.5) * u * 0.26;
      const px = (a) => x0 + Math.sin(t * 0.7 + a * 4.2 + s + i * 2) * u * 0.14 * (0.3 + a);
      for (const [w, col] of [[0.24, '#5f5a22'], [0.1, '#8a8438']]) {
        c.strokeStyle = col; c.lineWidth = u * w; c.beginPath();
        for (let k = 0; k <= 10; k++) c.lineTo(px(k / 10), -k / 10 * h); c.stroke();
      }
    }
  } },
  anemone: { n: '말미잘', d(c, u, t, s) {
    const hue = [338, 18, 285, 160][Math.floor(sr(s, 9) * 4)];
    c.lineCap = 'round';
    for (let i = 0; i < 13; i++) {                       // 하늘거리는 촉수
      const a = -Math.PI / 2 + (i - 6) * 0.2, len = u * (0.5 + sr(s, i) * 0.2), w = Math.sin(t * 1.5 + i * 0.8 + s) * 0.3;
      const bx = Math.cos(a) * u * 0.16, by = -u * 0.3 + Math.sin(a) * u * 0.05;
      const ex = bx + Math.cos(a + w) * len, ey = by + Math.sin(a + w) * len;
      c.strokeStyle = `hsl(${hue} 85% ${66 + (i % 3) * 5}%)`; c.lineWidth = u * 0.075;
      c.beginPath(); c.moveTo(bx, by); c.quadraticCurveTo(bx + Math.cos(a) * len * 0.6, by + Math.sin(a) * len * 0.6, ex, ey); c.stroke();
      c.fillStyle = `hsl(${hue} 90% 88%)`; c.beginPath(); c.arc(ex, ey, u * 0.045, 0, TAU); c.fill();
    }
    const g = c.createLinearGradient(0, -u * 0.36, 0, 0); g.addColorStop(0, `hsl(${hue} 55% 46%)`); g.addColorStop(1, `hsl(${hue} 50% 26%)`);
    c.fillStyle = g; c.beginPath(); c.moveTo(-u * 0.24, 0); c.quadraticCurveTo(-u * 0.27, -u * 0.34, -u * 0.17, -u * 0.36); c.lineTo(u * 0.17, -u * 0.36); c.quadraticCurveTo(u * 0.27, -u * 0.34, u * 0.24, 0); c.fill();
  } },
  coral: { n: '산호', d(c, u, t, s) {
    const hue = [8, 330, 28, 280][Math.floor(sr(s, 9) * 4)]; let n = 0;
    c.lineCap = 'round';
    const br = (x, y, a, len, dep) => {
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      c.strokeStyle = `hsl(${hue} 78% ${52 + (4 - dep) * 5}%)`; c.lineWidth = u * 0.035 * (dep + 1.2);
      c.beginPath(); c.moveTo(x, y); c.lineTo(x2, y2); c.stroke();
      if (dep > 0) { br(x2, y2, a - 0.38 - sr(s, ++n) * 0.3, len * 0.74, dep - 1); br(x2, y2, a + 0.38 + sr(s, ++n) * 0.3, len * 0.74, dep - 1); }
      else { c.fillStyle = `hsl(${hue} 85% 80%)`; c.beginPath(); c.arc(x2, y2, u * 0.03, 0, TAU); c.fill(); }
    };
    br(0, 0, -Math.PI / 2, u * 0.34, 4);
  } },
  clam: { n: '조개', d(c, u) {
    const R = u * 0.4;
    c.fillStyle = '#f3e6d2'; c.strokeStyle = '#bfa385'; c.lineWidth = u * 0.025; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(0, 0);
    for (let k = 0; k <= 14; k++) { const a = Math.PI * 1.08 + k / 14 * Math.PI * 0.84, rr = R * (1 + (k % 2 ? 0 : 0.06)); c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr * 0.92); }
    c.closePath(); c.fill(); c.stroke();
    for (let k = 1; k < 7; k++) { const a = Math.PI * 1.08 + k / 7 * Math.PI * 0.84; c.beginPath(); c.moveTo(0, -u * 0.02); c.lineTo(Math.cos(a) * R * 0.94, Math.sin(a) * R * 0.86); c.stroke(); }
    c.fillStyle = '#d8c2a6'; c.beginPath(); c.ellipse(0, -u * 0.01, u * 0.1, u * 0.045, 0, 0, TAU); c.fill();
  } },
  conch: { n: '소라', d(c, u) {
    c.strokeStyle = '#9a744c'; c.lineWidth = u * 0.02;
    for (let k = 0; k < 6; k++) {
      c.fillStyle = k % 2 ? '#e9cfa6' : '#d6b283';
      c.beginPath(); c.ellipse(k * u * 0.035, -u * 0.12 - k * u * 0.1, u * (0.33 - k * 0.055), u * (0.14 - k * 0.018), -0.12, 0, TAU); c.fill(); c.stroke();
    }
    c.fillStyle = '#5b3d22'; c.beginPath(); c.ellipse(-u * 0.1, -u * 0.09, u * 0.12, u * 0.055, -0.2, 0, TAU); c.fill();
  } },
  star: { n: '불가사리', d(c, u, t, s) {
    const hue = [22, 350, 265, 45][Math.floor(sr(s, 9) * 4)];
    c.save(); c.translate(0, -u * 0.1); c.scale(1, 0.62); c.rotate(sr(s, 3) * TAU);
    c.fillStyle = `hsl(${hue} 85% 56%)`; c.strokeStyle = `hsl(${hue} 85% 56%)`; c.lineWidth = u * 0.09; c.lineJoin = 'round';
    c.beginPath(); for (let k = 0; k < 10; k++) { const a = k * Math.PI / 5, r = k % 2 ? u * 0.13 : u * 0.36; c.lineTo(Math.cos(a) * r, Math.sin(a) * r); } c.closePath(); c.fill(); c.stroke();
    c.fillStyle = `hsl(${hue} 90% 78%)`;
    for (let k = 0; k < 5; k++) for (const r of [0.1, 0.2, 0.3]) { const a = k * TAU / 5; c.beginPath(); c.arc(Math.cos(a) * u * r, Math.sin(a) * u * r, u * 0.022, 0, TAU); c.fill(); }
    c.restore();
  } },
  crab: { n: '게', d(c, u, t, s, moving) {
    const step = moving ? t * 9 : 0, by = -u * 0.22;
    c.lineCap = 'round'; c.strokeStyle = '#b53a2c'; c.lineWidth = u * 0.045;
    for (const sd of [-1, 1]) for (let i = 0; i < 3; i++) {            // 다리
      const lift = Math.sin(step + i * 2.1 + (sd > 0 ? 1 : 0)) * u * 0.04, x1 = sd * u * (0.2 + i * 0.03), x2 = sd * u * (0.4 + i * 0.05);
      c.beginPath(); c.moveTo(x1, by + u * 0.05); c.lineTo(x2 - sd * u * 0.06, by - u * 0.03 + lift + i * u * 0.04); c.lineTo(x2, -u * 0.01 + Math.min(0, lift)); c.stroke();
    }
    for (const sd of [-1, 1]) {                                        // 집게발
      const up = Math.sin(t * 1.3 + s + sd) * 0.25, cx = sd * u * 0.36, cy = by - u * 0.16 - up * u * 0.1;
      c.lineWidth = u * 0.06; c.beginPath(); c.moveTo(sd * u * 0.2, by - u * 0.04); c.lineTo(cx, cy); c.stroke();
      c.fillStyle = '#d8493a'; c.beginPath(); c.arc(cx, cy, u * 0.1, 0, TAU); c.fill();
      c.strokeStyle = '#7d2216'; c.lineWidth = u * 0.025; c.beginPath(); c.moveTo(cx, cy + u * 0.01); c.lineTo(cx + sd * u * 0.085, cy - u * 0.075); c.stroke(); c.strokeStyle = '#b53a2c';
    }
    const g = c.createLinearGradient(0, by - u * 0.17, 0, by + u * 0.15); g.addColorStop(0, '#ea5c48'); g.addColorStop(1, '#a8321f');
    c.fillStyle = g; c.beginPath(); c.ellipse(0, by, u * 0.27, u * 0.17, 0, 0, TAU); c.fill();
    c.strokeStyle = '#a8321f'; c.lineWidth = u * 0.03;
    for (const sd of [-1, 1]) { c.beginPath(); c.moveTo(sd * u * 0.08, by - u * 0.14); c.lineTo(sd * u * 0.1, by - u * 0.26); c.stroke(); c.fillStyle = '#1a1010'; c.beginPath(); c.arc(sd * u * 0.1, by - u * 0.27, u * 0.035, 0, TAU); c.fill(); }
  } },
  urchin: { n: '성게', d(c, u, t, s) {
    const cy = -u * 0.22; c.lineCap = 'round'; c.strokeStyle = '#2a1f3d'; c.lineWidth = u * 0.028;
    for (let k = 0; k < 26; k++) { const a = k / 26 * TAU + Math.sin(t * 0.8 + k + s) * 0.05, r = u * (0.3 + sr(s, k) * 0.08); c.beginPath(); c.moveTo(Math.cos(a) * u * 0.1, cy + Math.sin(a) * u * 0.1); c.lineTo(Math.cos(a) * r, cy + Math.sin(a) * r); c.stroke(); }
    c.fillStyle = '#3b2b57'; c.beginPath(); c.arc(0, cy, u * 0.15, 0, TAU); c.fill();
  } },
  rock: { n: '바위', d(c, u, t, s) {
    for (const [dx, w, h] of [[-0.2, 0.36, 0.3], [0.12, 0.42, 0.44 + sr(s, 1) * 0.15]]) {
      const g = c.createLinearGradient(0, -u * h, 0, 0); g.addColorStop(0, '#8e9aa2'); g.addColorStop(1, '#3b4650');
      c.fillStyle = g; c.beginPath(); c.ellipse(dx * u, 0, u * w, u * h, 0, Math.PI, TAU); c.fill();
      c.fillStyle = 'rgba(255,255,255,.08)'; c.beginPath(); c.ellipse(dx * u - u * w * 0.2, -u * h * 0.55, u * w * 0.4, u * h * 0.2, -0.3, 0, TAU); c.fill();
    }
  } },
  chest: { n: '보물상자', d(c, u, t, s) {
    const w = u * 0.7, h = u * 0.3, open = 0.25 + Math.sin(t * 0.6 + s) * 0.08;
    c.fillStyle = '#f5d76e'; c.beginPath(); c.ellipse(0, -h, w * 0.38, u * 0.07, 0, 0, TAU); c.fill();           // 금빛
    c.save(); c.translate(-w / 2, -h); c.rotate(-open);                                                            // 뚜껑
    c.fillStyle = '#8d5a2b'; c.beginPath(); c.moveTo(0, 0); c.lineTo(w, 0); c.quadraticCurveTo(w, -u * 0.24, w / 2, -u * 0.24); c.quadraticCurveTo(0, -u * 0.24, 0, 0); c.fill();
    c.fillStyle = '#e3b23c'; c.fillRect(w * 0.14, -u * 0.23, u * 0.06, u * 0.23); c.fillRect(w * 0.78, -u * 0.23, u * 0.06, u * 0.23); c.restore();
    c.fillStyle = '#7a4a22'; c.fillRect(-w / 2, -h, w, h);
    c.fillStyle = '#e3b23c'; c.fillRect(-w / 2 + w * 0.14, -h, u * 0.06, h); c.fillRect(-w / 2 + w * 0.78, -h, u * 0.06, h); c.fillRect(-u * 0.05, -h, u * 0.1, u * 0.12);
    c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(-w / 2, -u * 0.05, w, u * 0.05);
  } },
  wood: { n: '유목', d(c, u) {
    c.lineCap = 'round';
    for (const [w, col] of [[0.17, '#5a3d25'], [0.08, '#7b5838']]) {
      c.strokeStyle = col; c.lineWidth = u * w;
      c.beginPath(); c.moveTo(-u * 0.65, -u * 0.05); c.quadraticCurveTo(-u * 0.1, -u * 0.12, u * 0.6, -u * 0.5); c.stroke();
      c.lineWidth = u * w * 0.6; c.beginPath(); c.moveTo(u * 0.05, -u * 0.2); c.quadraticCurveTo(u * 0.1, -u * 0.5, -u * 0.12, -u * 0.72); c.stroke();
    }
  } },
};
let decoMode = false, decoSel = null, decoDrag = null;
const decos = { sea: [], fresh: [] };
for (const k of ['sea', 'fresh']) { try { decos[k] = JSON.parse(LS('aq-deco-' + k, '[]')).filter((d) => DECO[d.t]); } catch { decos[k] = []; } }
const saveDecos = () => setLS('aq-deco-' + water, JSON.stringify(decos[water]));
const decoU = () => clamp(Math.min(W, H) * 0.15, 50, 96);
const decoPos = (d) => ({ x: d.x * W, y: sandY + d.y * (H - sandY), u: decoU() * d.s * (0.8 + 0.45 * d.y) });
// front=false: 물고기 뒤(바닥 안쪽), front=true: 물고기 앞(화면 가까운 쪽)
function drawDecos(c, t, dt, front) {
  for (const d of decos[water]) {
    if ((d.y > 0.42) !== front) continue;
    const p = decoPos(d), walk = d.t === 'crab' && !decoMode;
    c.save(); c.translate(p.x + (walk ? Math.sin(t * 0.3 + d.seed) * p.u * 1.1 : 0), p.y);
    DECO[d.t].d(c, p.u, t, d.seed, walk && Math.abs(Math.cos(t * 0.3 + d.seed)) > 0.25); c.restore();
    if (d.t === 'chest' && Math.random() < dt * 0.7) bubbles.push({ x: p.x + rand(-8, 8), y: p.y - p.u * 0.4, r: rand(1.5, 3.5), v: rand(30, 55), s: rand(0, 6) });
  }
}
function setDecoMode(on) {
  decoMode = on; decoSel = null; $('decoBar').hidden = !on; document.body.classList.toggle('deco', on); $('decoBtn').classList.toggle('on', on); syncDecoCtl();
  if (on && !$('dTray').children.length) for (const [k, it] of Object.entries(DECO)) {       // 고르는 판은 처음 열 때 만든다
    const b = document.createElement('button'), cv = makeCanvas(104, 104), cc = cv.getContext('2d');
    cc.translate(52, k === 'weed' || k === 'kelp' ? 100 : 82); it.d(cc, k === 'weed' || k === 'kelp' ? 44 : 62, 0, 1.7, false);
    b.append(cv, document.createTextNode(it.n));
    b.onclick = () => {
      if (decos[water].length >= 40) return toast('한 어항에 40개까지 놓을 수 있어요');
      const d = { t: k, x: rand(0.2, 0.8), y: rand(0.02, 0.4), s: 1, seed: +rand(0, 9).toFixed(2) };
      decos[water].push(d); decos[water].sort((a, c2) => a.y - c2.y); decoSel = d; saveDecos(); syncDecoCtl();
    };
    $('dTray').append(b);
  }
}
function syncDecoCtl() { for (const id of ['dSmall', 'dBig', 'dDel']) $(id).disabled = !decoSel; $('decoHint').textContent = decoSel ? `${DECO[decoSel.t].n}: 끌어서 옮기고 크기를 바꿔요` : '골라서 추가하고, 바닥에서 끌어 옮겨요'; }
$('decoBtn').onclick = () => setDecoMode(!decoMode);
$('dDone').onclick = () => setDecoMode(false);
$('dSmall').onclick = () => { if (decoSel) { decoSel.s = Math.max(0.5, +(decoSel.s - 0.2).toFixed(2)); saveDecos(); } };
$('dBig').onclick = () => { if (decoSel) { decoSel.s = Math.min(2.6, +(decoSel.s + 0.2).toFixed(2)); saveDecos(); } };
$('dDel').onclick = () => { if (decoSel) { decos[water].splice(decos[water].indexOf(decoSel), 1); decoSel = null; saveDecos(); syncDecoCtl(); } };
tank.addEventListener('pointerdown', (e) => {
  if (!decoMode) return;
  const list = decos[water]; decoSel = null;
  for (let i = list.length - 1; i >= 0; i--) { const p = decoPos(list[i]); if (Math.abs(e.clientX - p.x) < Math.max(26, p.u * 0.55) && e.clientY > p.y - Math.max(44, p.u * 1.3) && e.clientY < p.y + 22) { decoSel = list[i]; break; } }
  if (decoSel) { const p = decoPos(decoSel); decoDrag = { dx: e.clientX - p.x, dy: e.clientY - p.y }; tank.setPointerCapture(e.pointerId); }
  syncDecoCtl();
});
tank.addEventListener('pointermove', (e) => {
  if (!decoDrag || !decoSel) return;
  decoSel.x = clamp((e.clientX - decoDrag.dx) / W, 0.03, 0.97); decoSel.y = clamp((e.clientY - decoDrag.dy - sandY) / (H - sandY), -0.02, 0.8);
});
const endDecoDrag = () => { if (decoDrag) { decoDrag = null; decos[water].sort((a, b) => a.y - b.y); saveDecos(); } };
tank.addEventListener('pointerup', endDecoDrag); tank.addEventListener('pointercancel', endDecoDrag);

let last = 0;
function frame(now) {
  // 느린 기기에서는 해상도를 낮춰 부드럽게
  if (G) { slowAcc += Math.min(0.1, (now - last) / 1000); if (++slowN >= 90) { const avg = slowAcc / slowN; slowAcc = slowN = 0; if (avg > 0.03 && dprCap > 1) { dprCap = dprCap > 1.5 ? 1.5 : 1; resize(); } } }
  const t = now / 1000, dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
  const sc = SCENES[water], dTarget = daylight();
  dayCur = dayCur == null ? dTarget : dayCur + (dTarget - dayCur) * Math.min(1, dt * 1.4);
  const day = dayCur, dusk = 4 * day * (1 - day);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (G) ctx.clearRect(0, 0, W, H);
  if (!G) {
  // 물
  const g = ctx.createLinearGradient(0, 0, 0, H);
  [0, 0.45, 1].forEach((p, i) => g.addColorStop(p, mix(sc.night[i], sc.day[i], day)));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // 물 건너편에 흐릿하게 비치는 바위: 물이 맑아 보이게 하는 깊이감
  for (const [al, base, amp, f1, f2, ph] of [[0.28, 0.2, 0.13, 0.009, 0.023, 1], [0.4, 0.1, 0.1, 0.014, 0.037, 3.3]]) {
    ctx.globalAlpha = al; ctx.fillStyle = mix(sc.night[2], sc.day[2], day); ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W + 16; x += 16) ctx.lineTo(x, sandY - H * base - (Math.sin(x * f1 + ph) * 0.5 + 0.5) * H * amp - (Math.sin(x * f2 + ph * 2) * 0.5 + 0.5) * H * amp * 0.4);
    ctx.lineTo(W, H); ctx.fill();
  }
  ctx.globalAlpha = 1;
  const gl = ctx.createLinearGradient(0, surfY, 0, surfY + H * 0.16); gl.addColorStop(0, `rgba(235,252,255,${0.06 + 0.4 * day})`); gl.addColorStop(1, 'rgba(235,252,255,0)');
  ctx.fillStyle = gl; ctx.fillRect(0, surfY, W, H * 0.16);
  // 햇살 (밤에는 희미한 달빛)
  ctx.globalCompositeOperation = 'lighter';
  const rayA = 0.03 + 0.085 * day;
  for (let i = 0; i < 9; i++) {
    const x = W * (i / 8) * 1.25 + Math.sin(t * 0.21 + i * 1.7) * W * 0.09, w = W * 0.04 * (1 + 0.45 * Math.sin(t * 0.33 + i * 2.1)), sl = H * 0.28;
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
  }
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
  ctx.fillStyle = sg; sandPath(); ctx.fill();
  for (const p of pebbles) { ctx.fillStyle = `rgb(${p.c},${p.c + 8},${p.c + 4})`; ctx.beginPath(); ctx.ellipse(p.x * W, sandY + 8 + p.y * (H - sandY - 8), p.r * 1.4, p.r, 0, 0, 7); ctx.fill(); }

  if (!G) {
  // 바닥에 일렁이는 빛 그물
  ctx.save(); sandPath(); ctx.clip(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.1 + 0.55 * day;
  drawCaustic(caus1, t * 13, t * 4, 300, 0.42, 0, sandY - 14, W, H); ctx.globalAlpha *= 0.7; drawCaustic(caus2, -t * 9, t * 6, 390, 0.42, 0, sandY - 14, W, H);
  ctx.restore();
  }

  drawDecos(ctx, t, dt, false);
  // 먹이
  ctx.fillStyle = '#c98a4a';
  for (let i = pellets.length - 1; i >= 0; i--) {
    const p = pellets[i];
    if (p.y < sandY + 2) { p.y += p.vy * dt; p.x += Math.sin(t * 2.2 + p.s) * 8 * dt; } else if ((p.life -= dt) < 0) { pellets.splice(i, 1); continue; }
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, 7); ctx.fill();
  }
  // 물고기
  for (const f of shown) stepFish(f, dt, t);
  ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#fff';
  for (const m of motes) {
    m.y -= m.v * dt; if (m.y < 0) m.y = 1;
    const mx = ((m.x + Math.sin(t * 0.3 + m.s) * 0.02 + t * 0.004) % 1) * W, my = surfY + m.y * (sandY - surfY);
    ctx.globalAlpha = (0.12 + 0.2 * day) * (0.5 + 0.5 * Math.sin(t * 0.9 + m.s)); ctx.beginPath(); ctx.arc(mx, my, m.r, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;

  drawDecos(ctx, t, dt, true);
  // 공기방울
  if (Math.random() < dt * 2.2) { const src = sc.weeds[(Math.random() * 3) | 0].x * W; bubbles.push({ x: src + rand(-6, 6), y: sandY, r: rand(1.5, 4.5), v: rand(25, 60), s: rand(0, 6) }); }
  ctx.strokeStyle = 'rgba(220,245,255,.55)'; ctx.fillStyle = 'rgba(220,245,255,.12)'; ctx.lineWidth = 1;
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i]; b.y -= b.v * dt; const bx = b.x + Math.sin(t * 2 + b.s) * 4;
    if (b.y < surfY + 2) { bubbles.splice(i, 1); continue; }
    ctx.beginPath(); ctx.arc(bx, b.y, b.r, 0, 7); ctx.fill(); ctx.stroke();
  }
  if (!G) {
  // 수면: 물 위쪽은 수조 덮개 그늘, 경계는 찰랑이는 밝은 선
  const wave = (x) => surfY + Math.sin(x * 0.03 + t * 1.6) * 2.2 + Math.sin(x * 0.071 - t * 2.3) * 1.3;
  const hood = ctx.createLinearGradient(0, 0, 0, surfY); hood.addColorStop(0, '#050f17'); hood.addColorStop(1, mix('#0a1c28', '#2a5a6c', day));
  ctx.fillStyle = hood; ctx.beginPath(); ctx.moveTo(0, 0); for (let x = 0; x <= W + 8; x += 8) ctx.lineTo(x, wave(x)); ctx.lineTo(W, 0); ctx.fill();
  ctx.strokeStyle = `rgba(240,253,255,${0.35 + 0.55 * day})`; ctx.lineWidth = 1.6; ctx.beginPath(); for (let x = 0; x <= W + 8; x += 8) ctx.lineTo(x, wave(x)); ctx.stroke();
  // 밤에는 전체를 어둡게
  if (day < 0.99) { ctx.fillStyle = `rgba(2,8,26,${0.42 * (1 - day)})`; ctx.fillRect(0, 0, W, H); }
  // 유리 수조 느낌: 가장자리 그늘과 비스듬한 유리 반사
  const vg = ctx.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.35, W / 2, H * 0.48, Math.hypot(W, H) * 0.62);
  vg.addColorStop(0, 'rgba(0,12,28,0)'); vg.addColorStop(1, 'rgba(0,12,28,.42)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  const gr = ctx.createLinearGradient(0, 0, W, W * 0.6); gr.addColorStop(0.18, 'rgba(255,255,255,0)'); gr.addColorStop(0.26, 'rgba(255,255,255,.055)'); gr.addColorStop(0.33, 'rgba(255,255,255,.02)'); gr.addColorStop(0.4, 'rgba(255,255,255,.05)'); gr.addColorStop(0.46, 'rgba(255,255,255,0)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  }
  const hc = G ? hctx : ctx;
  if (G) { hctx.setTransform(DPR, 0, 0, DPR, 0, 0); hctx.clearRect(0, 0, W, H); }
  // 이름표
  if (showTags) {
    hc.font = '600 12px -apple-system, "Apple SD Gothic Neo", sans-serif'; hc.textAlign = 'center'; hc.textBaseline = 'middle';
    for (const f of shown) {
      const b = bounds(f), txt = `${f.rec.name || '물고기'} ${f.rec.lengthCm}cm`, tw = hc.measureText(txt).width + 14, ty = Math.max(70, f.y - b.ey - 14);
      hc.fillStyle = 'rgba(4,20,38,.6)'; hc.beginPath(); (hc.roundRect ? hc.roundRect(f.x - tw / 2, ty - 10, tw, 20, 10) : hc.rect(f.x - tw / 2, ty - 10, tw, 20)); hc.fill();
      hc.fillStyle = '#eaf6ff'; hc.fillText(txt, f.x, ty + 0.5);
    }
    hc.textAlign = 'left'; hc.textBaseline = 'alphabetic';
  }
  // 꾸미기에서 고른 장식 표시
  if (decoMode && decoSel) { const p = decoPos(decoSel); hc.strokeStyle = '#5fe0ff'; hc.lineWidth = 2; hc.setLineDash([6, 5]); hc.beginPath(); hc.ellipse(p.x, p.y - p.u * 0.38, Math.max(30, p.u * 0.7), Math.max(30, p.u * 0.8), 0, 0, 7); hc.stroke(); hc.setLineDash([]); }
  // 눈금자: 실제 크기 가늠용
  const unit = pxPerCm * 10 < 26 ? 50 : 10, bl = unit * pxPerCm, by = H - 24;
  hc.strokeStyle = hc.fillStyle = 'rgba(255,255,255,.75)'; hc.lineWidth = 1.5;
  hc.beginPath(); hc.moveTo(16, by - 5); hc.lineTo(16, by); hc.lineTo(16 + bl, by); hc.lineTo(16 + bl, by - 5); hc.stroke();
  hc.font = '12px sans-serif'; hc.fillText(`${unit}cm`, 20 + bl, by + 2);
  if (G) glRender(t, day, dusk, sc);
  requestAnimationFrame(frame);
}

// 물고기를 누르면 정보, 빈 물을 누르면 먹이
let down = null;
tank.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
tank.addEventListener('pointerup', (e) => {
  if (decoMode) return;
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
  let bookYear = null;
  [...fishes].sort((a, b) => (b.rec.date || '').localeCompare(a.rec.date || '')).forEach((f) => {
    if (yearOf(f.rec) !== bookYear) { bookYear = yearOf(f.rec); const hd = document.createElement('div'); hd.className = 'byear'; hd.textContent = yearName(bookYear); g.append(hd); }
    const b = document.createElement('button'); b.className = 'card';
    const img = document.createElement('img'); img.src = f.img.src; b.append(img);
    const n = document.createElement('b'); n.textContent = `${f.rec.name || '물고기'} · ${f.rec.lengthCm}cm`; b.append(n);
    const s = document.createElement('small'); s.textContent = [dateText(f.rec.date), f.rec.place].filter(Boolean).join(' · ') || '기록 없음'; b.append(s);
    b.onclick = () => { $('book').hidden = true; if (yearSel !== 'all' && yearOf(f.rec) !== yearSel) setYear(yearOf(f.rec)); setWater(f.rec.water); openSheet(f); }; g.append(b);
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

// 설치 안내: 앱 안 브라우저(카카오톡·인스타 등)에서는 사파리로 열도록, 사파리에서는 홈 화면에 추가하도록 알려 준다
(() => {
  const ua = navigator.userAgent, standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (standalone) return;
  const inApp = /KAKAOTALK|Instagram|FBAN|FBAV|NAVER|Line\/|DaumApps|everytimeApp|BAND/i.test(ua), ios = /iPhone|iPad|iPod/i.test(ua);
  let msg = '';
  if (inApp) msg = '여기서는 설치가 안 돼요. 화면의 <b>⋯ 또는 공유 버튼 → Safari(다른 브라우저)로 열기</b>를 눌러 주세요.';
  if (!msg) return;
  $('tipText').innerHTML = msg; $('tip').hidden = false;
  $('tipClose').onclick = () => { $('tip').hidden = true; if (!inApp) setLS('aq-tip', 'x'); };
})();

// ───────────────────────── 사용 설명서: 처음 들어오면 한 번 보여 주고, '사용법' 버튼으로 다시 본다
(() => {
  const pages = $('gPages'), n = pages.children.length, dots = $('gDots');
  dots.innerHTML = '<i></i>'.repeat(n);
  const cur = () => Math.round(pages.scrollLeft / Math.max(1, pages.clientWidth));
  const sync = () => { const c = cur(); [...dots.children].forEach((d, i) => d.classList.toggle('on', i === c)); $('gNext').textContent = c === n - 1 ? '시작하기' : '다음'; };
  pages.addEventListener('scroll', sync, { passive: true });
  const close = () => { $('guide').hidden = true; setLS('aq-guide', '1'); };
  $('gNext').onclick = () => { const c = cur(); if (c >= n - 1) close(); else pages.scrollTo({ left: (c + 1) * pages.clientWidth, behavior: 'smooth' }); };
  $('gClose').onclick = close;
  const setOs = (os) => {
    document.querySelectorAll('#gOs button').forEach((b) => b.classList.toggle('on', b.dataset.os === os));
    document.querySelectorAll('.gsteps[data-os]').forEach((o) => (o.hidden = o.dataset.os !== os));
  };
  document.querySelectorAll('#gOs button').forEach((b) => (b.onclick = () => setOs(b.dataset.os)));
  setOs(/Android/i.test(navigator.userAgent) ? 'and' : 'ios');
  const open = () => { $('guide').hidden = false; pages.scrollLeft = 0; sync(); };
  $('helpBtn').onclick = open;
  if (LS('aq-guide', '') !== '1' || location.hash === '#guide') open();
})();
