// ЭкоГИС ЗКО — клиент. Данные: Supabase (если заполнен config.js) или demo-data.json.
// Тексты интерфейса — в i18n.js (русский и казахский).
'use strict';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ---------------- language ----------------
let LANG = 'ru';
try { if (localStorage.getItem('ecogis-lang') === 'kk') LANG = 'kk'; } catch (e) { /* storage unavailable */ }
const tr = () => window.I18N[LANG];
const loc = (obj, field) => (LANG === 'kk' && obj[field + '_kk']) || obj[field];

// ---------------- data source ----------------
const CFG = window.ECO_CONFIG || {};
const sb = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;

async function fetchAll(table, columns = '*') {
  // PostgREST отдаёт не больше 1000 строк за раз — читаем страницами
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}
async function loadData() {
  if (sb) {
    const [geo, stations, monthly, enterprises] = await Promise.all([
      sb.rpc('districts_geojson').then(r => { if (r.error) throw r.error; return r.data; }),
      fetchAll('stations_xy'),
      fetchAll('district_monthly'),
      fetchAll('enterprises', 'name,oked,category,district_id,source_url'),
    ]);
    return { geo, stations, monthly, enterprises };
  }
  const r = await fetch('demo-data.json');
  if (!r.ok) throw new Error('demo-data.json не найден');
  const j = await r.json();
  return { geo: j.districts, stations: j.stations, monthly: j.monthly, enterprises: j.enterprises || [] };
}

// ---------------- metric definitions (texts live in i18n.js) ----------------
const MODES = {
  districts: {},
  score: { key: 'score', stops: [[40,'#a62a24'],[50,'#d4702c'],[60,'#d8b13b'],[70,'#7fae3e'],[80,'#3b8a3e']], norm: 65,
    cat: v => v >= 80 ? 0 : v >= 65 ? 1 : v >= 50 ? 2 : 3, colors: ['#7fae3e','#d8b13b','#d4702c','#e0553f'] },
  aqi: { key: 'aqi', stops: [[0,'#3b8a3e'],[50,'#7fae3e'],[100,'#d8b13b'],[150,'#d4702c'],[200,'#a62a24']], norm: 100, max: 200,
    cat: v => v <= 50 ? 0 : v <= 100 ? 1 : v <= 150 ? 2 : 3, colors: ['#7fae3e','#d8b13b','#d4702c','#e0553f'] },
  wpi: { key: 'wpi', stops: [[.3,'#2f7fb5'],[1,'#4f9e5a'],[2.5,'#d8b13b'],[4,'#d4702c'],[6,'#a62a24']], norm: 2.5, max: 6,
    cat: v => v <= .3 ? 0 : v <= 1 ? 1 : v <= 2.5 ? 2 : v <= 4 ? 3 : v <= 6 ? 4 : 5, colors: ['#4fa0d0','#7fae3e','#d8b13b','#d4702c','#e0553f','#e0553f'] },
  soil: { key: 'soil', stops: [[5,'#4f8f45'],[20,'#9aa94a'],[35,'#c9a046'],[50,'#b36a32'],[65,'#7f3a22']], norm: 30, max: 65,
    cat: v => v < 15 ? 0 : v < 30 ? 1 : v < 45 ? 2 : 3, colors: ['#7fae3e','#d8b13b','#d4702c','#e0553f'] },
  ndvi: { key: 'ndvi', stops: [[.05,'#a8834a'],[.2,'#c9b25c'],[.35,'#8fae4a'],[.5,'#4e8f3a'],[.65,'#2d6b2e']], max: .65,
    cat: v => v < .15 ? 0 : v < .3 ? 1 : v < .45 ? 2 : 3, colors: ['#c9a046','#d8b13b','#8fae4a','#5d9b45'] },
  precip: { key: 'precip', stops: [[0,'#a8834a'],[10,'#c9b25c'],[20,'#9fb88a'],[35,'#5b9bc4'],[60,'#2f5f9a']], max: 60,
    cat: v => v < 10 ? 0 : v < 20 ? 1 : v < 40 ? 2 : 3, colors: ['#c9a046','#d8b13b','#8fae4a','#5b9bc4'] },
};
const MT = k => tr().modes[k];                       // texts of a mode
const catOf = (k, v) => { const i = MODES[k].cat(v); return [MT(k).cats[i], MODES[k].colors[i]]; };
const METRICS = ['aqi', 'wpi', 'soil', 'ndvi', 'precip'];
const SCORED = ['aqi', 'wpi', 'soil'];               // осадки — климатический фон, в эко-индекс не входят
const LIMITS = { aqi: 150, wpi: 3.5, soil: 50 };
const POLIT = ['#7d8f4a','#a86b45','#4f7a9a','#9a8a4a','#6b5a8a','#b08a3a','#5f8f6f','#8f5f5f','#a09060','#4f8a8a','#b07a5a','#7a9a5a','#c4b28a'];

function hex2rgb(h) { return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); }
function ramp(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1] = stops[i - 1], [v2, c2] = stops[i];
    if (v <= v2) { const f = (v - v1) / (v2 - v1), a = hex2rgb(c1), b = hex2rgb(c2); return `rgb(${a.map((x, j) => Math.round(x + (b[j] - x) * f)).join(',')})`; }
  }
  return stops[stops.length - 1][1];
}
const fmtV = (k, v) => v == null ? '—' : k === 'wpi' || k === 'ndvi' ? v.toFixed(2) : k === 'soil' || k === 'precip' ? v.toFixed(1) : String(Math.round(v));

// ---------------- model (filled after load) ----------------
let D = [], byId = {}, STATIONS = [], ENTERPRISES = [], MONTHS = [], T = 0, DATA = {}, ALERTS = [];
const S = { t: 0, mode: 'score', sel: 'burlin', playing: false, speed: 2, inspected: new Set(), sortKey: 'score', sortDir: -1, timer: null };
const ym = t => MONTHS[t].split('-').map(Number);
const fmtDate = t => { const [y, m] = ym(t); return tr().date(y, m - 1); };
const fmtShort = t => { const [y, m] = ym(t); return `${tr().monthsShort[m - 1]} ${y}`; };
const akey = a => a.id + a.kind + a.t;

function buildModel({ geo, stations, monthly, enterprises }) {
  D = geo.features.map((f, i) => ({ id: f.id, ...f.properties, geometry: f.geometry, politColor: POLIT[i % POLIT.length] }));
  byId = Object.fromEntries(D.map(d => [d.id, d]));
  STATIONS = stations;
  ENTERPRISES = enterprises || [];
  MONTHS = [...new Set(monthly.map(r => r.month.slice(0, 7)))].sort();
  T = MONTHS.length;
  const tIndex = Object.fromEntries(MONTHS.map((m, i) => [m, i]));
  DATA = {};
  for (const d of D) DATA[d.id] = Array.from({ length: T }, () => Object.fromEntries([...METRICS, 'score'].map(k => [k, null])));
  for (const r of monthly) if (DATA[r.district_id] && r.metric in DATA[r.district_id][0]) DATA[r.district_id][tIndex[r.month.slice(0, 7)]][r.metric] = +r.value;
  for (const d of D) {
    // растительный компонент индекса считаем от пикового NDVI района, чтобы зима не «штрафовала»
    const peak = Math.max(...DATA[d.id].map(r => r.ndvi ?? 0));
    for (const r of DATA[d.id]) {
      if (SCORED.some(k => r[k] == null)) continue;
      const a = clamp(r.aqi / 200), w = clamp(r.wpi / 5), s = clamp(r.soil / 65), v = clamp((.55 - peak) / .45);
      r.score = Math.round(100 - 100 * (.35 * a + .25 * w + .2 * s + .2 * v));
    }
  }
  ALERTS = [];
  for (const d of D) DATA[d.id].forEach((r, t) => {
    for (const k of Object.keys(LIMITS)) if (r[k] != null && r[k] > LIMITS[k]) ALERTS.push({ t, id: d.id, kind: k, v: r[k], sev: r[k] / LIMITS[k] });
  });
  if (!byId[S.sel]) S.sel = D[0].id;
  S.t = Math.min(S.t || T - 1, T - 1);
}

// ---------------- projection (lon/lat → SVG) ----------------
let project;
function setupProjection() {
  const K = Math.cos(50 * Math.PI / 180), W = 800, H = 570, PAD = 28;
  const pts = D.flatMap(d => d.geometry.coordinates.flat(2));
  const xs = pts.map(p => p[0] * K), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const s = Math.min((W - 2 * PAD) / (x1 - x0), (H - 2 * PAD) / (y1 - y0));
  const ox = (W - (x1 - x0) * s) / 2, oy = (H - (y1 - y0) * s) / 2;
  project = (lon, lat) => [+(ox + (lon * K - x0) * s).toFixed(1), +(oy + (y1 - lat) * s).toFixed(1)];
}
function pathD(geom) {
  return geom.coordinates.map(poly => poly.map(ring => 'M' + ring.map(([x, y]) => project(x, y).join(',')).join(' ') + 'Z').join('')).join('');
}
function labelPoint(geom) {
  let best = null;
  for (const poly of geom.coordinates) {
    const p = poly[0].map(([x, y]) => project(x, y));
    let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < p.length - 1; i++) { const c = p[i][0] * p[i + 1][1] - p[i + 1][0] * p[i][1]; A += c; cx += (p[i][0] + p[i + 1][0]) * c; cy += (p[i][1] + p[i + 1][1]) * c; }
    if (A && (!best || Math.abs(A) > best[0])) best = [Math.abs(A), cx / (3 * A), cy / (3 * A)];
  }
  return [best[1], best[2]];
}
const LABEL_NUDGE = { bayterek: [-38, -18], uralsk: [0, 24], bokey: [0, 6] };
const RIVER = [[55.1,51.75],[54.5,51.62],[53.9,51.52],[53.4,51.53],[52.5,51.45],[51.9,51.35],[51.37,51.23],[51.3,50.9],[51.2,50.5],[51.17,50.2],[51.4,49.7],[51.75,49.3],[51.87,49.03],[51.9,48.4]];

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function drawMap() {
  setupProjection();
  for (const g of ['neighbours', 'provs', 'river', 'labels', 'stations', 'poi']) $(g).innerHTML = '';
  [[120, 22, 0], [20, 250, -90], [470, 562, 0], [790, 420, 90]].forEach(([x, y, r], i) => {
    el('text', { class: 'nlabel', x, y, transform: `rotate(${r} ${x} ${y})` }, $('neighbours')).textContent = tr().neighbours[i];
  });
  for (const d of D) {
    const p = el('path', { d: pathD(d.geometry), class: 'prov', tabindex: '0', 'aria-label': loc(d, 'name') }, $('provs'));
    p.addEventListener('click', () => select(d.id));
    p.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(d.id); } });
    p.addEventListener('mousemove', e => showTip(e, d));
    p.addEventListener('mouseleave', () => { $('tip').style.display = 'none'; });
    d.el = p;
    const [lx, ly] = labelPoint(d.geometry), [nx, ny] = LABEL_NUDGE[d.id] || [0, 0];
    el('text', { x: lx + nx, y: ly + ny, 'text-anchor': 'middle', class: 'plabel' + (d.is_city ? ' small' : '') }, $('labels')).textContent = loc(d, 'short');
    // предприятия I категории: значок с числом рядом с подписью (точных координат в источнике нет)
    const n = ENTERPRISES.filter(e => e.district_id === d.id).length;
    if (n) {
      const [bx, by] = d.is_city ? [lx + nx + 30, ly + ny - 4] : [lx + nx, ly + ny + 18];
      const g = el('g', { class: 'ent-badge', transform: `translate(${bx} ${by})` }, $('poi'));
      el('rect', { x: -15, y: -9, width: 30, height: 15, rx: 2, fill: '#2b1a10', stroke: '#e2c47a', 'stroke-width': 1 }, g);
      el('path', { d: 'M-12 4v-7l3 2v-2l3 2v-5h2v10z', fill: '#ff8a3a' }, g);
      el('text', { x: 6, y: 3, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: '#f6e6b8' }, g).textContent = n;
      el('title', {}, g).textContent = tr().entBadge(n);
    }
  }
  const rv = RIVER.map(p => project(...p));
  el('path', { d: 'M' + rv.map(p => p.join(',')).join(' L'), fill: 'none', stroke: '#3f7fb0', 'stroke-width': 3.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: .9 }, $('river'));
  const [rx, ry] = rv[11];
  el('text', { x: rx + 8, y: ry, 'font-size': 11, fill: '#cfe4f5', 'font-style': 'italic', transform: `rotate(60 ${rx + 8} ${ry})` }, $('river')).textContent = tr().river;
  for (const s of STATIONS) {
    const [x, y] = project(s.lon, s.lat);
    const r = el('rect', { x: x - 3.5, y: y - 3.5, width: 7, height: 7, transform: `rotate(45 ${x} ${y})`, fill: '#f6e6b8', stroke: '#1a1a1a' }, $('stations'));
    el('title', {}, r).textContent = `${tr().stationPrefix}: ${loc(s, 'name')}`;
  }
  const [kx, ky] = project(53.2, 51.35);
  el('circle', { cx: kx, cy: ky, r: 7, fill: '#2b1a10', stroke: '#e2c47a', 'stroke-width': 1.5 }, $('poi'));
  el('path', { d: `M${kx} ${ky - 7}c-3 4-4 6-4 8a4 4 0 0 0 8 0c0-2-1-4-4-8z`, fill: '#ff8a3a' }, $('poi'));
  el('text', { x: kx - 36, y: ky - 12, 'font-size': 11, fill: '#1c1a16', 'font-weight': 700 }, $('poi')).textContent = tr().karach;
}

function showTip(e, d) {
  const r = DATA[d.id][S.t], tip = $('tip'), box = $('stage').getBoundingClientRect();
  const k = MODES[S.mode].key || 'score';
  const n = STATIONS.filter(s => s.district_id === d.id).length;
  tip.innerHTML = `<b>${esc(loc(d, 'name'))}</b><br>${MT(k).title}: <b>${fmtV(k, r[k])}</b><br><span style="color:var(--muted)">${tr().tipOpen(n)}</span>`;
  tip.style.display = 'block';
  let x = e.clientX - box.left + 14; const y = e.clientY - box.top + 14;
  if (x + 240 > box.width) x -= 260;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}

// ---------------- controls ----------------
Object.keys(MODES).forEach(k => {
  const b = document.createElement('button'); b.type = 'button'; b.dataset.mode = k;
  b.addEventListener('click', () => { S.mode = k; render(); }); $('modeGrid').appendChild(b);
});
for (let i = 1; i <= 5; i++) {
  const b = document.createElement('button'); b.type = 'button';
  b.addEventListener('click', () => { S.speed = i; if (S.playing) startTimer(); render(); }); $('speeds').appendChild(b);
}
const tl = $('timeline');
tl.addEventListener('input', () => { S.t = +tl.value; render(); });
$('playBtn').addEventListener('click', togglePlay);
$('langBtn').addEventListener('click', () => {
  LANG = LANG === 'ru' ? 'kk' : 'ru';
  try { localStorage.setItem('ecogis-lang', LANG); } catch (e) { /* storage unavailable */ }
  applyLang();
});
const OVERLAYS = ['ledgerOv', 'addOv', 'dataOv'];
$('ledgerBtn').addEventListener('click', () => { $('ledgerOv').classList.add('open'); renderLedger(); $('ledgerClose').focus(); });
$('ledgerClose').addEventListener('click', () => $('ledgerOv').classList.remove('open'));
$('addBtn').addEventListener('click', openAdd);
$('addClose').addEventListener('click', () => $('addOv').classList.remove('open'));
$('dataBtn').addEventListener('click', () => { $('dataOv').classList.add('open'); $('dataClose').focus(); });
$('dataClose').addEventListener('click', () => $('dataOv').classList.remove('open'));
for (const id of OVERLAYS) $(id).addEventListener('click', e => { if (e.target.id === id) $(id).classList.remove('open'); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { OVERLAYS.forEach(id => $(id).classList.remove('open')); $('chatDrawer').hidden = true; if ($('eventOv').classList.contains('open')) closeEvent(false); return; }
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'button', 'path', 'select'].includes(tag) || !T) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.key === '+' || e.key === '=') { S.speed = Math.min(5, S.speed + 1); if (S.playing) startTimer(); render(); }
  if (e.key === '-') { S.speed = Math.max(1, S.speed - 1); if (S.playing) startTimer(); render(); }
});

function togglePlay() {
  if ($('eventOv').classList.contains('open') || !T) return;
  S.playing = !S.playing;
  if (S.playing) { if (S.t >= T - 1) S.t = 0; startTimer(); } else clearInterval(S.timer);
  render();
}
function startTimer() { clearInterval(S.timer); S.timer = setInterval(tick, [0, 1800, 1200, 750, 450, 250][S.speed]); }
function tick() {
  if (S.t >= T - 1) { S.playing = false; clearInterval(S.timer); render(); return; }
  S.t++; render();
  const fresh = ALERTS.filter(a => a.t === S.t).sort((a, b) => b.sev - a.sev);
  if (fresh.length) { S.playing = false; clearInterval(S.timer); openEvent(fresh[0]); render(); }
}
function select(id) { S.sel = id; render(); }

// ---------------- event popup ----------------
let curEvent = null;
const ART = {
  aqi: `<rect width="460" height="120" fill="#6b6f74"/><rect y="80" width="460" height="40" fill="#4b4636"/><rect x="90" y="40" width="22" height="42" fill="#2a2a2a"/><rect x="130" y="25" width="22" height="57" fill="#2a2a2a"/><circle cx="101" cy="30" r="16" fill="#8d8d8d" opacity=".8"/><circle cx="125" cy="16" r="20" fill="#9a9a9a" opacity=".7"/><circle cx="160" cy="10" r="24" fill="#a8a8a8" opacity=".6"/><path d="M300 82h80l-10-30h-60z" fill="#2a2a2a"/><path d="M340 50c-8 10-12 16-12 22a12 12 0 0 0 24 0c0-6-4-12-12-22z" fill="#ff8a3a"/>`,
  wpi: `<rect width="460" height="120" fill="#7a8a8c"/><path d="M0 60 Q60 50 120 62 T240 60 T360 62 T460 58 V120 H0z" fill="#4c6b5a"/><path d="M0 75 Q60 65 120 77 T240 75 T360 77 T460 73" stroke="#9fb38a" stroke-width="3" fill="none"/><ellipse cx="200" cy="95" rx="60" ry="8" fill="#3a3a22" opacity=".7"/><ellipse cx="320" cy="100" rx="40" ry="6" fill="#3a3a22" opacity=".6"/>`,
  soil: `<rect width="460" height="120" fill="#c9b07a"/><path d="M0 70 Q80 40 160 70 T320 65 T460 70 V120 H0z" fill="#b39058"/><path d="M0 95 Q100 70 200 95 T460 92 V120 H0z" fill="#9a7746"/><path d="M60 100l20-8M220 105l25-10M360 100l20-6" stroke="#6b4f2a" stroke-width="2"/>`,
};
function fillEvent() {
  const a = curEvent, d = byId[a.id], src = (loc(d, 'sources') || [])[0];
  $('evTitle').textContent = tr().evTitle(tr().kinds[a.kind], loc(d, 'name'));
  $('evFrom').textContent = tr().evFrom(fmtDate(a.t));
  $('evText').textContent = tr().evText(MT(a.kind).title, fmtV(a.kind, a.v), tr().limits[a.kind], (src || tr().noSource).toLowerCase());
}
function openEvent(a) {
  curEvent = a; $('evArt').innerHTML = ART[a.kind]; fillEvent();
  $('eventOv').classList.add('open'); $('evInspect').focus();
}
function closeEvent(inspect) {
  if (curEvent && inspect) S.inspected.add(akey(curEvent));
  if (curEvent) S.sel = curEvent.id;
  curEvent = null; $('eventOv').classList.remove('open'); render();
}
$('evInspect').addEventListener('click', () => closeEvent(true));
$('evNote').addEventListener('click', () => closeEvent(false));

// ---------------- render ----------------
function avg(k) { const v = D.map(d => DATA[d.id][S.t][k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
function render() {
  if (!T) return;
  const mode = MODES[S.mode];
  for (const d of D) {
    const v = mode.key ? DATA[d.id][S.t][mode.key] : 0;
    d.el.classList.toggle('nodata', v == null);
    d.el.setAttribute('fill', S.mode === 'districts' ? d.politColor : v == null ? '#55574f' : ramp(mode.stops, v));
    d.el.classList.toggle('sel', d.id === S.sel);
  }
  const sel = byId[S.sel].el; sel.parentNode.appendChild(sel);
  for (const d of D) if (d.is_city && d.id !== S.sel) d.el.parentNode.appendChild(d.el);

  document.querySelectorAll('#modeGrid button').forEach(b => { b.classList.toggle('on', b.dataset.mode === S.mode); b.textContent = MT(b.dataset.mode).label; });
  document.querySelectorAll('#speeds button').forEach((b, i) => { b.classList.toggle('on', i < S.speed); b.style.height = (10 + i * 3) + 'px'; b.setAttribute('aria-label', `${tr().speed} ${i + 1}`); });
  $('dateLbl').textContent = fmtDate(S.t); tl.value = S.t;
  $('tStart').textContent = fmtShort(0); $('tEnd').textContent = fmtShort(T - 1);
  $('pausedTag').style.visibility = S.playing ? 'hidden' : 'visible';
  $('playBtn').innerHTML = S.playing ? '<svg viewBox="0 0 14 14"><rect x="2" y="1" width="4" height="12"/><rect x="8" y="1" width="4" height="12"/></svg>' : '<svg viewBox="0 0 14 14"><path d="M3 1l10 6-10 6z"/></svg>';
  $('playBtn').setAttribute('aria-label', S.playing ? tr().pause : tr().play);

  const open = ALERTS.filter(a => a.t === S.t).length, f = (v, n) => v == null ? '—' : v.toFixed(n), c = tr().chips;
  $('chips').innerHTML = [
    [f(avg('score'), 0), c.score], [f(avg('aqi'), 0), c.aqi], [f(avg('wpi'), 2), c.wpi],
    [f(avg('ndvi'), 2), c.ndvi], [f(avg('precip'), 1), c.precip], [STATIONS.length, c.stations], [open, c.alerts, open > 0],
  ].map(([v, l, al]) => `<div class="chip${al ? ' alert' : ''}"><b>${v}</b><span>${l}</span></div>`).join('');

  renderLegend(); renderPanel(); renderAlerts();
  if ($('ledgerOv').classList.contains('open')) renderLedger();
}
function renderLegend() {
  const m = MODES[S.mode];
  if (S.mode === 'districts') { $('legend').innerHTML = `<div class="title">${tr().legendDistricts(D.filter(d => !d.is_city).length)}</div>`; return; }
  const st = m.stops, grad = st.map(([v, c]) => `${c} ${((v - st[0][0]) / (st[st.length - 1][0] - st[0][0]) * 100).toFixed(0)}%`).join(',');
  $('legend').innerHTML = `<div class="title">${MT(S.mode).title}</div><div class="ramp" style="background:linear-gradient(90deg,${grad})"></div><div class="ticks">${st.map(([v]) => `<span>${v}</span>`).join('')}</div>`;
}
function spark(k) {
  const m = MODES[k], vals = DATA[S.sel].map(r => r[k]), ok = vals.filter(v => v != null), W = 290, H = 78, P = 6;
  if (ok.length < 2) return `<p style="margin:0;color:var(--muted);font-size:12px">${tr().notEnough}</p>`;
  const lo = Math.min(...ok, m.norm ?? Infinity) * .9, hi = Math.max(...ok, m.norm ?? -Infinity) * 1.05;
  const x = i => P + i * (W - 2 * P) / Math.max(1, T - 1), y = v => H - 16 - (v - lo) / (hi - lo) * (H - 26);
  const idx = vals.map((v, i) => [v, i]).filter(([v]) => v != null);
  const pts = idx.map(([v, i]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${x(idx[0][1])},${H - 16} ${pts} ${x(idx[idx.length - 1][1])},${H - 16}`;
  // осадки — столбики, остальное — линия
  const marks = k === 'precip'
    ? idx.map(([v, i]) => `<rect x="${(x(i) - 4).toFixed(1)}" y="${y(v).toFixed(1)}" width="8" height="${(H - 16 - y(v)).toFixed(1)}" fill="${i === S.t ? '#fff3c4' : '#5b9bc4'}"/>`).join('')
    : `<polygon points="${area}" fill="#b8964a22"/><polyline points="${pts}" fill="none" stroke="#e2c47a" stroke-width="1.6"/>`;
  const norm = m.norm != null ? `<line x1="${P}" x2="${W - P}" y1="${y(m.norm)}" y2="${y(m.norm)}" stroke="#e0553f" stroke-dasharray="4 3" stroke-width="1"/><text x="${W - P}" y="${y(m.norm) - 3}" text-anchor="end" font-size="9" fill="#e0553f">${tr().threshold} ${m.norm}</text>` : '';
  const cur = k !== 'precip' && vals[S.t] != null ? `<circle cx="${x(S.t)}" cy="${y(vals[S.t])}" r="3.5" fill="#fff3c4" stroke="#000"/>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${tr().dynamics}: ${MT(k).title}">
    <line x1="${P}" x2="${W - P}" y1="${H - 16}" y2="${H - 16}" stroke="#3d382c"/>${marks}${norm}${cur}
    <text x="${P}" y="${H - 3}" font-size="9" fill="#a59f90">${fmtShort(0)}</text><text x="${W - P}" y="${H - 3}" font-size="9" fill="#a59f90" text-anchor="end">${fmtShort(T - 1)}</text></svg>`;
}
function renderPanel() {
  const d = byId[S.sel], r = DATA[d.id][S.t], sc = r.score != null ? catOf('score', r.score) : [tr().noData, '#8a8a80'];
  const sk = MODES[S.mode].key || 'score';
  const st = STATIONS.filter(s => s.district_id === d.id);
  const ents = ENTERPRISES.filter(e => e.district_id === d.id);
  const rows = METRICS.map(k => {
    const m = MODES[k], v = r[k], [cn, cc] = v != null ? catOf(k, v) : [tr().noData, '#8a8a80'];
    return `<div class="metric"><span class="lbl">${MT(k).title}</span><span class="val">${fmtV(k, v)}</span>
      <div class="bar"><i style="width:${v != null ? clamp(v / m.max) * 100 : 0}%;background:${v != null ? ramp(m.stops, v) : 'transparent'}"></i></div>
      <span class="cat"><span class="pill" style="background:${cc}">${cn}</span></span></div>`;
  }).join('');
  $('provPanel').innerHTML = `
    <div class="prov-head">
      <svg class="shield" viewBox="0 0 34 40" aria-hidden="true"><path d="M2 2h30v17c0 10-7 16-15 19C9 35 2 29 2 19z" fill="${d.politColor}" stroke="#e2c47a" stroke-width="2"/></svg>
      <div><h2>${esc(loc(d, 'name'))}</h2><small>${esc(loc(d, 'center') || '')}${d.area_km2 ? ` · ${Number(d.area_km2).toLocaleString(LANG === 'kk' ? 'kk' : 'ru')} ${tr().km2}` : ''} · ${fmtDate(S.t)}</small></div>
    </div>
    <div class="prov-body">
      <div class="score"><span class="num" style="color:${sc[1]}">${r.score ?? '—'}</span>
        <div><div style="font-size:12px;color:var(--muted)">${tr().scoreOf}</div><span class="pill" style="background:${sc[1]}">${sc[0]}</span></div></div>
      ${rows}
      <div><h3>${tr().dynamics}: ${MT(sk).label.toLowerCase()}</h3><div class="spark-wrap">${spark(sk)}</div></div>
      <div><h3>${tr().stations} (${st.length})</h3><ul class="src">${st.map(s => `<li>${esc(loc(s, 'name'))}</li>`).join('') || `<li>${tr().noStations}</li>`}</ul></div>
      <div><h3>${tr().impacts}</h3><ul class="src">${(loc(d, 'sources') || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>
      ${ents.length ? `<div><h3>${tr().enterprises} (${ents.length})</h3><ul class="src ents">${ents.map(e => `<li>${esc(e.name)}<small>${esc(e.oked || '')}</small></li>`).join('')}</ul>
        <p class="src-note">${tr().entSource} <a href="${esc(ents[0].source_url || 'https://ecokarta.kz/company')}">ecokarta.kz</a></p></div>` : ''}
    </div>`;
}
function renderAlerts() {
  const list = ALERTS.filter(a => a.t <= S.t).sort((a, b) => b.t - a.t || b.sev - a.sev).slice(0, 40);
  $('alertList').innerHTML = list.length ? list.map(a => {
    const d = byId[a.id], col = a.sev > 1.12 ? 'var(--crit)' : 'var(--bad)', done = S.inspected.has(akey(a));
    return `<li data-id="${a.id}" tabindex="0"><span class="sev" style="background:${col}"></span><span><b>${esc(loc(d, 'short'))}</b>: ${tr().kinds[a.kind]} ${fmtV(a.kind, a.v)} ${MT(a.kind).unit}<br><small>${fmtShort(a.t)}</small>${done ? ` · <span class="done">${tr().inspected}</span>` : ''}</span></li>`;
  }).join('') : `<li class="empty">${tr().noAlerts}</li>`;
  $('alertList').querySelectorAll('li[data-id]').forEach(li => {
    const go = () => select(li.dataset.id); li.addEventListener('click', go); li.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });
}
const COLS = ['name', 'score', 'aqi', 'wpi', 'soil', 'ndvi', 'precip'];
function renderLedger() {
  $('ledHead').innerHTML = COLS.map(k => `<th data-k="${k}">${tr().ledgerCols[k]}${S.sortKey === k ? (S.sortDir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('');
  $('ledHead').querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.k; S.sortDir = S.sortKey === k ? -S.sortDir : -1; S.sortKey = k; renderLedger();
  }));
  const rows = D.map(d => ({ d, ...DATA[d.id][S.t], name: loc(d, 'name') }));
  rows.sort((a, b) => S.sortKey === 'name' ? -S.sortDir * a.name.localeCompare(b.name, LANG) : S.sortDir * ((a[S.sortKey] ?? -1e9) - (b[S.sortKey] ?? -1e9)));
  $('ledBody').innerHTML = rows.map(r => `<tr data-id="${r.d.id}"><td>${esc(r.name)}</td>${COLS.slice(1).map(k => {
    const m = MODES[k], v = r[k];
    return `<td><span style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:${v != null ? ramp(m.stops, v) : '#55574f'}"></span>${fmtV(k, v)}</td>`;
  }).join('')}</tr>`).join('');
  $('ledBody').querySelectorAll('tr').forEach(row => row.addEventListener('click', () => { select(row.dataset.id); $('ledgerOv').classList.remove('open'); }));
}

// ---------------- add measurement (Supabase Auth + insert) ----------------
let session = null;
if (sb) {
  sb.auth.getSession().then(({ data }) => { session = data.session; });
  sb.auth.onAuthStateChange((_e, s) => { session = s; if ($('addOv').classList.contains('open')) renderAdd(); });
}
function openAdd() { $('addOv').classList.add('open'); renderAdd(); }
function renderAdd() {
  const body = $('addBody'), L = tr();
  if (!sb) { body.innerHTML = `<p>${L.demo1}</p><p>${L.demo2}</p>`; return; }
  if (!session) {
    body.innerHTML = `<p>${L.loginIntro}</p>
      <form id="loginForm" class="form-body" style="padding:0">
        <label for="loginEmail">${L.email}<input id="loginEmail" type="email" required autocomplete="email"></label>
        <button class="btn" type="submit">${L.getLink}</button>
        <div class="form-msg" id="loginMsg"></div>
      </form>`;
    $('loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      const msg = $('loginMsg'); msg.className = 'form-msg'; msg.textContent = L.sending;
      const { error } = await sb.auth.signInWithOtp({ email: $('loginEmail').value.trim(), options: { emailRedirectTo: location.href.split('#')[0], shouldCreateUser: false } });
      if (error) { msg.className = 'form-msg err'; msg.textContent = L.linkFail(error.message); }
      else { msg.className = 'form-msg ok'; msg.textContent = L.linkSent; }
    });
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const groups = D.map(d => {
    const st = STATIONS.filter(s => s.district_id === d.id);
    return st.length ? `<optgroup label="${esc(loc(d, 'name'))}">${st.map(s => `<option value="${s.id}">${esc(loc(s, 'name'))}</option>`).join('')}</optgroup>` : '';
  }).join('');
  body.innerHTML = `<p>${L.signedAs} <b>${esc(session.user.email)}</b>. <button class="btn" type="button" id="logoutBtn">${L.logout}</button></p>
    <form id="mForm" class="form-body" style="padding:0">
      <label for="mStation">${L.station}<select id="mStation" required>${groups}</select></label>
      <div class="row2">
        <label for="mMetric">${L.metric}<select id="mMetric">${METRICS.map(k => `<option value="${k}">${MT(k).label} (${MT(k).unit})</option>`).join('')}</select></label>
        <label for="mValue">${L.value}<input id="mValue" type="number" step="any" required></label>
      </div>
      <label for="mDate">${L.measuredAt}<input id="mDate" type="date" required value="${today}" max="${today}"></label>
      <button class="btn" type="submit">${L.save}</button>
      <div class="form-msg" id="mMsg"></div>
    </form>`;
  $('logoutBtn').addEventListener('click', () => sb.auth.signOut());
  $('mForm').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('mMsg'); msg.className = 'form-msg'; msg.textContent = L.saving;
    const row = { station_id: +$('mStation').value, metric: $('mMetric').value, value: +$('mValue').value, measured_at: $('mDate').value, source: 'manual' };
    const { error } = await sb.from('measurements').insert(row);
    if (error) { msg.className = 'form-msg err'; msg.textContent = `${L.error}: ${error.message}`; return; }
    msg.className = 'form-msg ok'; msg.textContent = L.savedRefresh;
    await refresh(row.measured_at.slice(0, 7));
    msg.textContent = L.saved;
  });
}

// ---------------- AI assistant (Supabase Edge Function ask-ecogis → Claude) ----------------
const CHAT = [];              // {role: 'user'|'assistant', content}
let chatBusy = false, chatError = null;
function md(s) {
  // безопасная мини-разметка: экранирование, **жирный**, списки «- »
  const lines = esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split('\n');
  let html = '', inList = false;
  for (const l of lines) {
    const m = l.match(/^\s*[-•]\s+(.*)/);
    if (m) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${m[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (l.trim()) html += `<p>${l}</p>`;
  }
  return html + (inList ? '</ul>' : '');
}
function renderChat() {
  const L = tr();
  const bubbles = [`<div class="msg bot">${md(L.chatHello)}</div>`, ...CHAT.map(m => `<div class="msg ${m.role === 'user' ? 'me' : 'bot'}">${md(m.content)}</div>`)];
  if (!sb) bubbles.push(`<div class="msg sys">${md(L.chatDemo)}</div>`);
  if (chatBusy) bubbles.push(`<div class="msg bot typing">${L.thinking}</div>`);
  if (chatError) bubbles.push(`<div class="msg sys err">${esc(chatError)}</div>`);
  $('chatLog').innerHTML = bubbles.join('');
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  $('chatExamples').innerHTML = CHAT.length ? '' : L.chatExamples.map(q => `<button type="button" class="ex"${sb ? '' : ' disabled'}>${esc(q)}</button>`).join('');
  $('chatExamples').querySelectorAll('button').forEach(b => b.addEventListener('click', () => ask(b.textContent)));
  $('chatInput').placeholder = L.chatPlaceholder;
  $('chatInput').disabled = $('chatSend').disabled = !sb || chatBusy;
}
function applyMapActions(actions) {
  const a = (actions || []).at(-1);
  if (!a || !T) return;
  if (a.district_id && byId[a.district_id]) S.sel = a.district_id;
  if (a.metric && MODES[a.metric]) S.mode = a.metric;
  if (a.month && MONTHS.includes(a.month)) S.t = MONTHS.indexOf(a.month);
  render();
}
async function ask(q) {
  q = q.trim();
  if (!sb || chatBusy || !q) return;
  CHAT.push({ role: 'user', content: q.slice(0, 600) });
  chatBusy = true; chatError = null; renderChat();
  try {
    const { data, error } = await sb.functions.invoke('ask-ecogis', { body: { messages: CHAT, lang: LANG } });
    let code = data?.error;
    if (error) {
      try { code = (await error.context.json()).error; } catch (e) { code = 'network'; }
    }
    if (code) { chatError = tr().chatErrors[code] || tr().chatErrors.server_error; CHAT.pop(); }
    else { CHAT.push({ role: 'assistant', content: data.answer || '—' }); applyMapActions(data.actions); }
  } catch (e) {
    chatError = tr().chatErrors.network; CHAT.pop();
  }
  chatBusy = false; renderChat();
  if (!chatError) $('chatInput').focus();
}
$('chatBtn').addEventListener('click', () => { const d = $('chatDrawer'); d.hidden = !d.hidden; if (!d.hidden) { renderChat(); $('chatInput').focus(); } });
$('chatClose').addEventListener('click', () => { $('chatDrawer').hidden = true; });
$('chatForm').addEventListener('submit', e => { e.preventDefault(); const v = $('chatInput').value; $('chatInput').value = ''; ask(v); });
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); } });

// ---------------- language switch ----------------
function applyLang() {
  const L = tr();
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-i18n]').forEach(e => { e.textContent = L[e.dataset.i18n]; });
  $('langBtn').textContent = L.switchTo;
  $('langBtn').setAttribute('lang', LANG === 'ru' ? 'kk' : 'ru');
  $('map').setAttribute('aria-label', L.mapAria);
  $('modesPanel').setAttribute('aria-label', L.modesAria);
  $('alertsPanel').setAttribute('aria-label', L.alertsTitle);
  $('speeds').setAttribute('aria-label', L.speed);
  $('srcChip').textContent = sb ? L.srcLive : L.srcDemo;
  $('note').textContent = sb ? L.noteLive : L.noteDemo;
  if (T) { drawMap(); render(); }
  if (curEvent) fillEvent();
  if ($('addOv').classList.contains('open')) renderAdd();
  if (!$('chatDrawer').hidden) renderChat();
}

// ---------------- start ----------------
async function refresh(focusMonth) {
  const data = await loadData();
  buildModel(data);
  if (focusMonth && MONTHS.includes(focusMonth)) S.t = MONTHS.indexOf(focusMonth);
  tl.max = T - 1;
  drawMap(); render();
}
(async () => {
  $('srcChip').classList.toggle('live', !!sb);
  applyLang();
  try {
    await refresh();
    $('loading').remove();
  } catch (err) {
    console.error(err);
    $('loading').innerHTML = `${tr().loadFail}<small>${esc(err.message || err)}. ${sb ? tr().loadHintLive : tr().loadHintDemo}</small>`;
  }
})();
