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
const fishes = [];
const weeds = Array.from({ length: 9 }, (_, i) => ({ x: (i + rand(0.2, 0.8)) / 9, h: rand(0.12, 0.3), seed: rand(0, 9), hue: rand(95, 150), w: rand(5, 10) }));
const bubbles = [];
const pebbles = Array.from({ length: 26 }, () => ({ x: Math.random(), y: rand(0.2, 0.9), r: rand(2, 7), c: rand(60, 120) }));

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  tank.width = Math.round(W * DPR); tank.height = Math.round(H * DPR);
  sandY = H * 0.88; rescale();
}
function rescale() {
  // 어항 가로가 실제로 몇 cm인지: 가장 큰 물고기가 여유 있게 들어가도록
  const maxLen = fishes.reduce((m, f) => Math.max(m, f.rec.lengthCm), 0);
  const viewCm = Math.max(90, maxLen * 2.4) * Math.max(1, (W / H) * 0.75);
  pxPerCm = W / viewCm;
}
addEventListener('resize', resize);

// 물고기 한 마리 그리기: 세로 조각으로 잘라 꼬리 쪽일수록 크게 물결치게 한다 (그림은 머리가 왼쪽)
function drawFish(c, img, x, y, L, face, tilt, phase) {
  const iw = img.width, ih = img.height, s = L / iw, hh = ih * s;
  const N = clamp(Math.round(L / 5), 14, 44), dw = L / N, sw = iw / N;
  let sx = -face; if (Math.abs(sx) < 0.06) sx = sx < 0 ? -0.06 : 0.06;
  c.save(); c.translate(x, y); c.rotate(tilt * Math.sign(face || 1)); c.scale(sx, 1);
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N, env = 0.1 + 0.9 * t * t;
    const off = Math.sin(phase - t * 5.2) * env * L * 0.042;
    c.drawImage(img, i * sw, 0, sw, ih, -L / 2 + i * dw, -hh / 2 + off, dw + 0.8, hh);
  }
  c.restore();
}

const fishL = (f) => f.rec.lengthCm * pxPerCm * (0.88 + 0.12 * f.depth);
const fishH = (f) => fishL(f) * f.img.height / f.img.width;
function retarget(f) {
  const L = fishL(f), m = Math.min(W / 2, L / 2 + 8), top = Math.min(H * 0.14 + fishH(f) / 2, H * 0.4), bot = Math.max(top + 10, sandY - fishH(f) / 2 - 6);
  f.tx = rand(m, W - m); f.ty = rand(top, bot); f.timer = rand(5, 12); f.cruise = rand(0.28, 0.6);
}
function addFish(rec, img, fresh) {
  const f = { rec, img, x: 0, y: 0, dir: 1, face: 1, vy: 0, phase: rand(0, 6), depth: Math.random() };
  fishes.push(f); rescale();
  if (fresh) { f.x = W / 2; f.y = -fishH(f); }           // 새로 넣은 물고기는 위에서 퐁당
  else { f.x = rand(W * 0.15, W * 0.85); f.y = rand(H * 0.2, sandY - 30); }
  f.dir = f.face = Math.random() < 0.5 ? 1 : -1;
  retarget(f); if (fresh) { f.ty = H * 0.45; for (let i = 0; i < 14; i++) bubbles.push({ x: W / 2 + rand(-40, 40), y: rand(0, 60), r: rand(2, 6), v: rand(30, 70), s: rand(0, 6) }); }
  fishes.sort((a, b) => a.depth - b.depth);
  refreshHud();
}
function refreshHud() {
  $('empty').hidden = fishes.length > 0;
  $('count').textContent = fishes.length ? `내 어항 · ${fishes.length}마리` : '내 어항';
}

let last = 0;
function frame(now) {
  const t = now / 1000, dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // 물
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#35a9d6'); g.addColorStop(0.45, '#12689f'); g.addColorStop(1, '#072c50');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // 빛줄기
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i++) {
    const x = W * (i / 5) + Math.sin(t * 0.21 + i * 1.7) * W * 0.09, w = W * 0.07 * (1 + 0.35 * Math.sin(t * 0.33 + i * 2.1)), sl = H * 0.28;
    const rg = ctx.createLinearGradient(0, 0, 0, H * 0.85); rg.addColorStop(0, 'rgba(190,240,255,.13)'); rg.addColorStop(1, 'rgba(190,240,255,0)');
    ctx.fillStyle = rg; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + w, 0); ctx.lineTo(x + w * 2.4 - sl, H * 0.85); ctx.lineTo(x - w - sl, H * 0.85); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  // 수초
  ctx.lineCap = 'round';
  for (const wd of weeds) {
    const x0 = wd.x * W, hgt = wd.h * H, K = 9;
    for (let k = 0; k < K; k++) {
      const a = k / K, b = (k + 1) / K;
      const xa = x0 + Math.sin(t * 0.9 + a * 3 + wd.seed) * a * a * 26, xb = x0 + Math.sin(t * 0.9 + b * 3 + wd.seed) * b * b * 26;
      ctx.strokeStyle = `hsl(${wd.hue} 55% ${16 + a * 16}%)`; ctx.lineWidth = wd.w * (1 - a * 0.75);
      ctx.beginPath(); ctx.moveTo(xa, sandY + 6 - a * hgt); ctx.lineTo(xb, sandY + 6 - b * hgt); ctx.stroke();
    }
  }
  // 모래 바닥
  const sg = ctx.createLinearGradient(0, sandY - 10, 0, H); sg.addColorStop(0, '#b9ad84'); sg.addColorStop(1, '#4f5546');
  ctx.fillStyle = sg; ctx.beginPath(); ctx.moveTo(0, H);
  for (let x = 0; x <= W + 20; x += 20) ctx.lineTo(x, sandY + Math.sin(x * 0.013) * 7 + Math.sin(x * 0.041 + 2) * 3);
  ctx.lineTo(W, H); ctx.fill();
  for (const p of pebbles) { ctx.fillStyle = `rgb(${p.c},${p.c + 8},${p.c + 4})`; ctx.beginPath(); ctx.ellipse(p.x * W, sandY + 8 + p.y * (H - sandY - 8), p.r * 1.4, p.r, 0, 0, 7); ctx.fill(); }

  // 물고기
  for (const f of fishes) {
    const L = fishL(f), dx = f.tx - f.x, dy = f.ty - f.y;
    f.timer -= dt;
    if (Math.hypot(dx, dy) < L * 0.3 + 6 || f.timer < 0) retarget(f);
    if (Math.abs(dx) > L * 0.25) f.dir = dx > 0 ? 1 : -1;
    f.face += (f.dir - f.face) * Math.min(1, dt * 2.6);
    const v = Math.max(14, f.cruise * L) * (0.35 + 0.65 * Math.abs(f.face));
    f.x += f.face * v * dt;
    const tvy = clamp(dy * 0.6, -v * 0.45, v * 0.45);
    f.vy += (tvy - f.vy) * Math.min(1, dt * 1.6); f.y += f.vy * dt;
    f.phase += dt * (3.2 + 6 * f.cruise);
    ctx.globalAlpha = 0.84 + 0.16 * f.depth;
    drawFish(ctx, f.img, f.x, f.y + Math.sin(t * 0.8 + f.depth * 9) * 2, L, f.face, clamp(Math.atan2(f.vy, v) * 0.7, -0.4, 0.4), f.phase);
  }
  ctx.globalAlpha = 1;

  // 공기방울
  if (Math.random() < dt * 2.2) { const src = weeds[(Math.random() * 3) | 0].x * W; bubbles.push({ x: src + rand(-6, 6), y: sandY, r: rand(1.5, 4.5), v: rand(25, 60), s: rand(0, 6) }); }
  ctx.strokeStyle = 'rgba(220,245,255,.55)'; ctx.fillStyle = 'rgba(220,245,255,.12)'; ctx.lineWidth = 1;
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i]; b.y -= b.v * dt; const bx = b.x + Math.sin(t * 2 + b.s) * 4;
    if (b.y < -10) { bubbles.splice(i, 1); continue; }
    ctx.beginPath(); ctx.arc(bx, b.y, b.r, 0, 7); ctx.fill(); ctx.stroke();
  }
  // 눈금자: 실제 크기 가늠용
  const unit = pxPerCm * 10 < 26 ? 50 : 10, bl = unit * pxPerCm, by = H - 24;
  ctx.strokeStyle = ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(16, by - 5); ctx.lineTo(16, by); ctx.lineTo(16 + bl, by); ctx.lineTo(16 + bl, by - 5); ctx.stroke();
  ctx.font = '12px sans-serif'; ctx.fillText(`${unit}cm`, 20 + bl, by + 2);
  requestAnimationFrame(frame);
}

// 물고기를 누르면 정보 보기
let down = null;
tank.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
tank.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) return;
  for (let i = fishes.length - 1; i >= 0; i--) {
    const f = fishes[i];
    if (Math.abs(e.clientX - f.x) < Math.max(fishL(f) / 2, 26) && Math.abs(e.clientY - f.y) < Math.max(fishH(f) / 2, 26)) return openSheet(f);
  }
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
  const r = cur.rec; $('eName').value = r.name || ''; $('eLen').value = r.lengthCm; $('eDate').value = r.date || ''; $('ePlace').value = r.place || ''; $('eMemo').value = r.memo || '';
  $('sView').hidden = true; $('sForm').hidden = false;
};
$('eCancel').onclick = () => { $('sView').hidden = false; $('sForm').hidden = true; };
$('eSave').onclick = async () => {
  const len = parseFloat($('eLen').value); if (!(len > 0)) return toast('길이를 cm로 적어 주세요');
  const r = cur.rec; Object.assign(r, { name: $('eName').value.trim(), lengthCm: len, date: $('eDate').value, place: $('ePlace').value.trim(), memo: $('eMemo').value.trim() });
  await store('readwrite', (s) => s.put(r)); rescale(); showFacts(r); $('eCancel').onclick(); toast('저장했어요');
};
$('sDel').onclick = async () => {
  if (!confirm(`${cur.rec.name || '이 물고기'}를 어항에서 뺄까요?\n사진과 기록이 함께 지워져요.`)) return;
  await store('readwrite', (s) => s.delete(cur.rec.id));
  fishes.splice(fishes.indexOf(cur), 1); rescale(); refreshHud(); closeSheet();
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
    b.onclick = () => { $('book').hidden = true; openSheet(f); }; g.append(b);
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
    $('fName').value = ''; $('fLen').value = ''; $('fMemo').value = ''; $('fPlace').value = '';
    const today = new Date(), iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    $('fDate').value = m.date || iso;
    const bits = [m.date ? `사진에 기록된 날짜: ${dateText(m.date)}` : '사진에 날짜 정보가 없어 오늘 날짜로 넣었어요. 다르면 고쳐 주세요.'];
    bits.push(m.lat != null ? `사진에 기록된 위치: ${coordText(m)}` : '사진에 위치 정보가 없어요. 잡은 곳은 직접 적어 주세요.');
    $('fMeta').textContent = bits.join(' / ');
    if (E.place) E.place.then((p) => { if (p && !$('fPlace').value) $('fPlace').value = p; });
  }
  previewLoop();
};
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
      date: $('fDate').value, place: $('fPlace').value.trim(), memo: $('fMemo').value.trim(),
      lat: E.meta.lat ?? null, lon: E.meta.lon ?? null, createdAt: Date.now(),
      cutout: await toBlob(E.cut, 'image/png'), photo: await toBlob(cPhoto, 'image/jpeg', 0.85),
    };
    await store('readwrite', (s) => s.put(rec));
    addFish(rec, await loadImg(rec.cutout), true);
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
  refreshHud();
  navigator.storage?.persist?.();                         // 폰이 기록을 멋대로 지우지 않게 요청
})();

// 화면 꺼짐 방지 (어항을 켜 두고 볼 수 있게)
const keepAwake = () => { if (document.visibilityState === 'visible') navigator.wakeLock?.request('screen').catch(() => {}); };
document.addEventListener('visibilitychange', keepAwake); keepAwake();

// 인터넷 없이도 열리게 (홈 화면 앱)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
