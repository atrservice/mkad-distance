import { haversine, nearestOnLines, pointInPolygon, lineLength } from './geo.js';
import { MKAD_JUNCTIONS_OVERRIDE } from './config.js';
import { MKAD_OUTER_JUNCTIONS, MKAD_INNER_JUNCTIONS } from './mkad-junctions.js';

// Аварийное километровое кольцо (108 точек), если файла данных нет
export const MKAD_FALLBACK_RING = [
  [37.842762, 55.774558], [37.842789, 55.765220], [37.842627, 55.755723], [37.841828, 55.747399],
  [37.841217, 55.739103], [37.840175, 55.730482], [37.839160, 55.721939], [37.837121, 55.712203],
  [37.832620, 55.703048], [37.829512, 55.694287], [37.831353, 55.685290], [37.834605, 55.675945],
  [37.837597, 55.667752], [37.839348, 55.658667], [37.833842, 55.650053], [37.824787, 55.643713],
  [37.814564, 55.637347], [37.802473, 55.629130], [37.794235, 55.623758], [37.781928, 55.617713],
  [37.771139, 55.611755], [37.758725, 55.604956], [37.747945, 55.599677], [37.734785, 55.594143],
  [37.723062, 55.589234], [37.709425, 55.583983], [37.696256, 55.578834], [37.683167, 55.574019],
  [37.668911, 55.571999], [37.647765, 55.573093], [37.633419, 55.573928], [37.616719, 55.574732],
  [37.601070, 55.575816], [37.586536, 55.577800], [37.571938, 55.581271], [37.555732, 55.585143],
  [37.545132, 55.587509], [37.526366, 55.592200], [37.516108, 55.594728], [37.502274, 55.602490],
  [37.493910, 55.609685], [37.484846, 55.617424], [37.474668, 55.625801], [37.469925, 55.630207],
  [37.456864, 55.641041], [37.448195, 55.648794], [37.441125, 55.654675], [37.434424, 55.660424],
  [37.425980, 55.670701], [37.418712, 55.679940], [37.414868, 55.686873], [37.407528, 55.695697],
  [37.397952, 55.702805], [37.388969, 55.709657], [37.383283, 55.718273], [37.378369, 55.728581],
  [37.374991, 55.735201], [37.370248, 55.744789], [37.369188, 55.754350], [37.369053, 55.762936],
  [37.369619, 55.771444], [37.369853, 55.779722], [37.372943, 55.789542], [37.379824, 55.797230],
  [37.386876, 55.805796], [37.390397, 55.814629], [37.393236, 55.823606], [37.395275, 55.832510],
  [37.394709, 55.840376], [37.393056, 55.850141], [37.397314, 55.858801], [37.405588, 55.867051],
  [37.416601, 55.872703], [37.429429, 55.877041], [37.443596, 55.881091], [37.459065, 55.882828],
  [37.473096, 55.884625], [37.488610, 55.888897], [37.501600, 55.894232], [37.513206, 55.899578],
  [37.527597, 55.905260], [37.543443, 55.907687], [37.559577, 55.909388], [37.575531, 55.910907],
  [37.590344, 55.909257], [37.604637, 55.905472], [37.619603, 55.901637], [37.635961, 55.898533],
  [37.647648, 55.896973], [37.667878, 55.895449], [37.681721, 55.894868], [37.698807, 55.893884],
  [37.712363, 55.889094], [37.723636, 55.883555], [37.735791, 55.877501], [37.741261, 55.874698],
  [37.764519, 55.862464], [37.765992, 55.861979], [37.788216, 55.850257], [37.788522, 55.850383],
  [37.800586, 55.844167], [37.822819, 55.832707], [37.829754, 55.828789], [37.837148, 55.821072],
  [37.838926, 55.811599], [37.840004, 55.802781], [37.840965, 55.793991], [37.841576, 55.785017]
];

const GEOM_URL = 'data/mkad-yandex.txt';
const LS_KEY = 'mkad-junctions-v1';
const TTL_MS = 60 * 24 * 60 * 60 * 1000;
const OVERPASS_ENDPOINTS = [
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
// Только съезды (рампы), примыкающие к МКАД
const QUERY =
  '[out:json][timeout:40];' +
  'way["highway"~"^(trunk|primary|secondary|tertiary|motorway)$"]["name"="МКАД"]' +
  '(around:23000,55.72,37.62)->.mkad;' +
  'node(w.mkad)->.mn;' +
  'way(bn.mn)["highway"~"^(trunk_link|primary_link|secondary_link|tertiary_link|motorway_link)$"]->.links;' +
  '(.mkad;.links;);' +
  'out geom;';

/* ---------- Ручные списки съездов (js/mkad-junctions.js) ---------- */
function parseJunctionList(str, side){
  if (!str || typeof str !== 'string') return [];
  const out = [];
  str.split(';').forEach(pair => {
    const s = pair.trim();
    if (!s) return;
    const [lonS, latS] = s.split(',');
    const lon = parseFloat(lonS), lat = parseFloat(latS);
    if (!isFinite(lon) || !isFinite(lat)) return;
    out.push({ lon, lat, side, idx: out.length });
  });
  return out;
}
const manualJunctions =
  parseJunctionList(MKAD_OUTER_JUNCTIONS, 'outer')
    .concat(parseJunctionList(MKAD_INNER_JUNCTIONS, 'inner'));

function mergeOverride(parsed){
  const base = Array.isArray(parsed) ? parsed : [];
  let out = base;
  if (Array.isArray(MKAD_JUNCTIONS_OVERRIDE) && MKAD_JUNCTIONS_OVERRIDE.length){
    out = MKAD_JUNCTIONS_OVERRIDE.map(j => ({ lon: j.lon, lat: j.lat, side: j.side })).concat(out);
  }
  // Ручные упорядоченные списки — приоритетнее всего
  return manualJunctions.concat(out);
}

let state = {
  lines: [MKAD_FALLBACK_RING],
  polygon: MKAD_FALLBACK_RING,
  source: 'fallback',
  drawingRing: ringClosed(MKAD_FALLBACK_RING),
  junctions: mergeOverride([]),
  carriageways: null
};
let loading = null;
let staticLoaded = false;

export function getMKAD(){ return state; }

/* ---------- Быстрая локальная геометрия (файл Яндекса) ---------- */
export function loadMkadStatic(){
  if (staticLoaded) return Promise.resolve(state);
  return loadStaticGeometry();
}
async function loadStaticGeometry(){
  try {
    const res = await fetch(GEOM_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const txt = await res.text();
    const s = txt.indexOf('[[[');
    const e = txt.lastIndexOf(']]]');
    if (s === -1 || e === -1 || e <= s) throw new Error('не найдены координаты');
    const coords = JSON.parse(txt.slice(s, e + 3));
    const rings = (Array.isArray(coords) ? coords : [])
      .filter(line => Array.isArray(line) && line.length > 50)
      .map(line => line.map(c => [c[0], c[1]]));
    if (!rings.length) throw new Error('пусто');
    // Внешняя сторона = кольцо большей площади
    rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
    const outer = makeRing(rings[0]);
    const inner = rings[1] ? makeRing(rings[1]) : null;
    state.carriageways = inner ? { outer, inner } : { outer };
    state.polygon = outer.pts;
    state.drawingRing = ringClosed(outer.pts);
    state.lines = inner
      ? [outer.pts, inner.pts, MKAD_FALLBACK_RING]
      : [outer.pts, MKAD_FALLBACK_RING];
    state.source = 'yandex';
    staticLoaded = true;
    console.info('MKAD: геометрия Яндекса загружена, сторон:', inner ? 2 : 1);
  } catch (e){
    console.warn('MKAD: файл геометрии не использован, остаётся км-кольцо:', e);
  }
  return state;
}
function ringArea(pts){
  let sx = 0, sy = 0, area = 0;
  const kx = Math.cos(pts[0][1] * Math.PI / 180);
  const m = pts.map(p => [(p[0] - pts[0][0]) * kx * 111320, (p[1] - pts[0][1]) * 110540]);
  for (let i = 0; i < m.length; i++){
    const a = m[i], b = m[(i + 1) % m.length];
    area += a[0] * b[1] - b[0] * a[1];
    sx += a[0]; sy += a[1];
  }
  return area / 2;
}
function makeRing(ptsRaw){
  let pts = ptsRaw.slice();
  const f = pts[0], l = pts[pts.length - 1];
  if (pts.length > 2 && f[0] === l[0] && f[1] === l[1]) pts = pts.slice(0, -1);
  const cum = [0];
  for (let i = 1; i < pts.length; i++){
    cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]) / 1000);
  }
  const len = cum[cum.length - 1] + haversine(pts[pts.length - 1], pts[0]) / 1000;
  // +1, если порядок точек против часовой стрелки
  const ccwSign = ringArea(pts) > 0 ? 1 : -1;
  return { pts, cum, len, ccwSign };
}
function segLenKm(ring, i){
  const next = i + 1 < ring.cum.length ? ring.cum[i + 1] : ring.len;
  return next - ring.cum[i];
}
function pointAt(ring, t){
  let tt = ((t % ring.len) + ring.len) % ring.len;
  let i = 0;
  while (i < ring.cum.length - 1 && ring.cum[i + 1] < tt) i++;
  const a = ring.pts[i], b = ring.pts[(i + 1) % ring.pts.length];
  const f = segLenKm(ring, i) > 0 ? (tt - ring.cum[i]) / segLenKm(ring, i) : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
function nearestOnRing(ring, p){
  const kx = Math.cos(p[1] * Math.PI / 180);
  let best = { dist: Infinity, t: 0, point: ring.pts[0] };
  for (let i = 0; i < ring.pts.length; i++){
    const a = ring.pts[i], b = ring.pts[(i + 1) % ring.pts.length];
    const ax = a[0] * kx, ay = a[1], bx = b[0] * kx, by = b[1], px = p[0] * kx, py = p[1];
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const dist = haversine(p, point);
    if (dist < best.dist) best = { dist, t: ring.cum[i] + t * segLenKm(ring, i), point };
  }
  return best;
}
function bearingBetween(a, b){
  const kx = Math.cos(a[1] * Math.PI / 180);
  const east = (b[0] - a[0]) * kx;
  const north = b[1] - a[1];
  return Math.round((Math.atan2(east, north) * 180 / Math.PI + 360) % 360);
}

/* ---------- Съезды из OSM (фон, необязательно) ---------- */
export function ensureMKAD(){
  if (loading) return loading;
  loading = (async () => {
    await loadStaticGeometry();
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw){
        const cached = JSON.parse(raw);
        if (cached && cached.ts && Date.now() - cached.ts < TTL_MS && Array.isArray(cached.junctions)){
          state.junctions = mergeOverride(cached.junctions);
          return state;
        }
      }
    } catch (e) { /* кэш повреждён */ }
    for (const endpoint of OVERPASS_ENDPOINTS){
      try {
        const { mkadWays, linkWays } = await fetchFromOverpass(endpoint);
        if (mkadWays.length){
          const j = buildJunctions(mkadWays, linkWays);
          if (j.length){
            try { localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), junctions: j })); } catch (e) {}
            state.junctions = mergeOverride(j);
            break;
          }
        }
      } catch (e) {
        console.warn('Overpass недоступен:', endpoint, e);
      }
    }
    return state;
  })().finally(() => { loading = null; });
  return loading;
}
async function fetchFromOverpass(endpoint){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(QUERY),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const mkadWays = [], linkWays = [];
    for (const el of data.elements || []){
      if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
      const line = el.geometry.map(n => [n.lon, n.lat]);
      const hw = (el.tags && el.tags.highway) || '';
      if (/_(link)$/.test(hw)) linkWays.push(line);
      else mkadWays.push(line);
    }
    return { mkadWays, linkWays };
  } finally {
    clearTimeout(timer);
  }
}
function buildJunctions(mkadWays, linkWays){
  const nodeKeys = new Set();
  for (const w of mkadWays){
    for (const p of w) nodeKeys.add(p[0].toFixed(6) + ',' + p[1].toFixed(6));
  }
  const seen = new Set();
  const pts = [];
  for (const w of linkWays){
    for (const p of [w[0], w[w.length - 1]]){
      const key = p[0].toFixed(6) + ',' + p[1].toFixed(6);
      if (nodeKeys.has(key) && !seen.has(key)){ seen.add(key); pts.push([p[0], p[1]]); }
    }
  }
  if (!pts.length) return [];
  // Сторона: по близости к линии внешней/внутренней, иначе по смещению от км-кольца
  if (state.carriageways && state.carriageways.inner){
    return pts.map(p => {
      const dOut = nearestOnRing(state.carriageways.outer, p).dist;
      const dIn = nearestOnRing(state.carriageways.inner, p).dist;
      return { lon: p[0], lat: p[1], side: dOut <= dIn ? 'outer' : 'inner' };
    });
  }
  const offs = pts.map(p => {
    const r = nearestOnKmRing(p);
    const P = pointAtKm(r.t);
    const d = dirAtKm(r.t);
    const nL = [-d[1], d[0]];
    const kx = Math.cos(P[1] * Math.PI / 180);
    return ((p[0] - P[0]) * kx * 111320) * nL[0] + ((p[1] - P[1]) * 110540) * nL[1];
  });
  let thr = 0;
  if (pts.length >= 2) thr = (Math.min(...offs) + Math.max(...offs)) / 2;
  return pts.map((p, i) => ({ lon: p[0], lat: p[1], side: offs[i] > thr ? 'outer' : 'inner' }));
}

/* ---------- Км-кольцо: параметризация (аварийный путь) ---------- */
let cum = null, ringLenKm = 0;
function ensureCum(){
  if (cum) return;
  cum = [0];
  for (let i = 1; i < MKAD_FALLBACK_RING.length; i++){
    cum.push(cum[i - 1] + haversine(MKAD_FALLBACK_RING[i - 1], MKAD_FALLBACK_RING[i]) / 1000);
  }
  ringLenKm = cum[cum.length - 1] +
    haversine(MKAD_FALLBACK_RING[MKAD_FALLBACK_RING.length - 1], MKAD_FALLBACK_RING[0]) / 1000;
}
function segLenKmOld(i){
  const next = i + 1 < cum.length ? cum[i + 1] : ringLenKm;
  return next - cum[i];
}
function nearestOnKmRing(p){
  ensureCum();
  let best = { dist: Infinity, t: 0 };
  for (let i = 0; i < MKAD_FALLBACK_RING.length; i++){
    const a = MKAD_FALLBACK_RING[i];
    const b = MKAD_FALLBACK_RING[(i + 1) % MKAD_FALLBACK_RING.length];
    const kx = Math.cos(p[1] * Math.PI / 180);
    const ax = a[0] * kx, ay = a[1], bx = b[0] * kx, by = b[1], px = p[0] * kx, py = p[1];
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const dist = haversine(p, point);
    if (dist < best.dist) best = { dist, t: cum[i] + t * segLenKmOld(i) };
  }
  return best;
}
function pointAtKm(t){
  ensureCum();
  let tt = ((t % ringLenKm) + ringLenKm) % ringLenKm;
  let i = 0;
  while (i < cum.length - 1 && cum[i + 1] < tt) i++;
  const a = MKAD_FALLBACK_RING[i];
  const b = MKAD_FALLBACK_RING[(i + 1) % MKAD_FALLBACK_RING.length];
  const f = segLenKmOld(i) > 0 ? (tt - cum[i]) / segLenKmOld(i) : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
function dirAtKm(t){
  const p1 = pointAtKm(t), p2 = pointAtKm(t + 0.05);
  const kx = Math.cos(p1[1] * Math.PI / 180);
  const dx = (p2[0] - p1[0]) * kx, dy = p2[1] - p1[1];
  const L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
}

/* ---------- Точка въезда/съезда ---------- */
export function mkadAccessPoint(address, inside, role, shiftKm = 0.4){
  const side = inside ? 'inner' : 'outer';
  const js = (state.junctions || []).filter(j => j.side === side);
  const manual = js.filter(j => typeof j.idx === 'number');
  // 1) Ручные упорядоченные списки: старт — ближайший съезд; финиш — кандидаты по порядку
  if (manual.length){
    let bestPos = 0, bestD = Infinity;
    manual.forEach((j, i) => {
      const d = haversine(address, [j.lon, j.lat]);
      if (d < bestD){ bestD = d; bestPos = i; }
    });
    const len = manual.length;
    const at = (i) => manual[((i % len) + len) % len];
    let pick = at(bestPos);
    if (role === 'end'){
      if (shiftKm === 0.5) pick = at(bestPos + 1);
      else if (shiftKm === 0.9) pick = at(bestPos + 2);
    }
    return { point: [pick.lon, pick.lat], bearingDeg: null };
  }
  // 2) Реальные узлы съездов (Overpass/override), только базовый сдвиг
  if (shiftKm === 0.4 && js.length){
    let best = null;
    for (const j of js){
      const d = haversine(address, [j.lon, j.lat]);
      if (!best || d < best.d) best = { d, j };
    }
    return { point: [best.j.lon, best.j.lat], bearingDeg: null };
  }
  // 3) Точная линия нужной стороны (файл Яндекса)
  const cw = state.carriageways ? state.carriageways[side] : null;
  if (cw){
    const { t } = nearestOnRing(cw, address);
    // внешняя едет против часовой, внутренняя по часовой
    const travel = side === 'outer' ? cw.ccwSign : -cw.ccwSign;
    // старт — выше по ходу (съезд впереди), финиш — ниже (въезд позади)
    const dir = role === 'start' ? -travel : travel;
    const ts = t + dir * shiftKm;
    const point = pointAt(cw, ts);
    const bearingDeg = bearingBetween(point, pointAt(cw, ts + travel * 0.05));
    return { point, bearingDeg };
  }
  // 4) Аварийно: километровое кольцо
  const { t } = nearestOnKmRing(address);
  let ts;
  if (role === 'start') ts = inside ? t - shiftKm : t + shiftKm;
  else ts = inside ? t + shiftKm : t - shiftKm;
  const P = pointAtKm(ts);
  const ahead = inside ? pointAtKm(ts + 0.05) : pointAtKm(ts - 0.05);
  const bearingDeg = bearingBetween(P, ahead);
  const d = dirAtKm(ts);
  const n = [-d[1], d[0]];
  const kx = Math.cos(P[1] * Math.PI / 180);
  const ax = (address[0] - P[0]) * kx, ay = address[1] - P[1];
  const sign = (n[0] * ax + n[1] * ay) >= 0 ? 1 : -1;
  return {
    point: [
      P[0] + sign * n[0] * 15 / (111320 * kx),
      P[1] + sign * n[1] * 15 / 110540
    ],
    bearingDeg
  };
}
export function closestMKADPoint(lonLat){
  if (!state) return null;
  const res = nearestOnLines(state.lines, lonLat);
  return res ? res.point : null;
}
export function isInsideMKAD(lonLat){
  if (!state || !state.polygon) return null;
  return pointInPolygon(lonLat, state.polygon);
}
export function mkadRingForMap(){ return state ? state.drawingRing : null; }
function ringClosed(ring){
  if (!ring || ring.length < 3) return null;
  const first = ring[0], last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}