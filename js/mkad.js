import { haversine, nearestOnLines, pointInPolygon, lineLength } from './geo.js';

// Километровое кольцо МКАД (108 точек). Основа для точек въезда/съезда.
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

const LS_KEY = 'mkad-geometry-v4';
const TTL_MS = 60 * 24 * 60 * 60 * 1000;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const QUERY =
  '[out:json][timeout:20];' +
  'way["highway"~"^(trunk|primary|secondary|tertiary|motorway)$"]["name"="МКАД"]' +
  '(around:23000,55.72,37.62);out geom;';

const SHIFT_KM = 0.4;        // сдвиг вдоль кольца, чтобы съезд был впереди по ходу
const SIDE_OFFSET_M = 15;    // смещение к нужной стороне (внешняя/внутренняя)

// Состояние доступно СРАЗУ (километровое кольцо), живая геометрия догружается фоном
let state = {
  lines: [MKAD_FALLBACK_RING],
  polygon: MKAD_FALLBACK_RING,
  source: 'fallback',
  drawingRing: ringClosed(MKAD_FALLBACK_RING)
};
let loading = null;
let upgraded = false;

export function getMKAD(){ return state; }

// Фоновая догрузка живой геометрии; не блокирует расчёты
export function ensureMKAD(){
  if (upgraded) return Promise.resolve(state);
  if (!loading) loading = load().finally(() => { loading = null; });
  return loading;
}

async function load(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw){
      const cached = JSON.parse(raw);
      if (cached && cached.ts && Date.now() - cached.ts < TTL_MS &&
          Array.isArray(cached.lines) && cached.lines.length){
        upgraded = true;
        return setState(cached.lines, cached.ring || MKAD_FALLBACK_RING, 'cache');
      }
    }
  } catch (e) { /* кэш повреждён */ }

  for (const endpoint of OVERPASS_ENDPOINTS){
    try {
      const ways = await fetchFromOverpass(endpoint);
      if (ways.length){
        const saved = saveMerged(mergeSegments(ways), 'overpass');
        if (saved){ upgraded = true; return saved; }
      }
    } catch (e) {
      console.warn('Overpass недоступен:', endpoint, e);
    }
  }

  try {
    const lines = await fetchFromNominatim();
    if (lines.length){
      const saved = saveMerged(mergeSegments(lines), 'nominatim');
      if (saved){ upgraded = true; return saved; }
    }
  } catch (e) {
    console.warn('Nominatim geometry недоступен:', e);
  }
  return state;
}

function ringSane(ring){
  if (!ring || ring.length < 50) return false;
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (const p of ring){
    if (p[0] < lonMin) lonMin = p[0];
    if (p[0] > lonMax) lonMax = p[0];
    if (p[1] < latMin) latMin = p[1];
    if (p[1] > latMax) latMax = p[1];
  }
  return lonMin < 37.45 && lonMax > 37.75 &&
         latMin < 55.65 && latMax > 55.85 &&
         (lonMax - lonMin) < 1.2 && (latMax - latMin) < 0.8;
}

function saveMerged(merged, source){
  const { ring, closed, rest, lengthM } = merged;
  if (!ring) return null;
  const useRing = closed && lengthM > 100000 && lengthM < 130000 && ringSane(ring);
  const polygon = useRing ? ring : MKAD_FALLBACK_RING;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      ts: Date.now(),
      lines: [ring, ...rest],
      ring: useRing ? ringClosed(ring) : null
    }));
  } catch (e) { /* нет места */ }
  return setState([ring, ...rest], polygon, source);
}

async function fetchFromOverpass(endpoint){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 22000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(QUERY),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const lines = [];
    for (const el of data.elements || []){
      if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length > 1){
        lines.push(el.geometry.map(n => [n.lon, n.lat]));
      }
    }
    return lines;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromNominatim(){
  const params = new URLSearchParams({
    format: 'jsonv2', q: 'МКАД', limit: '3', dedupe: '1',
    countrycodes: 'ru', polygon_geojson: '1'
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch('https://nominatim.openstreetmap.org/search?' + params.toString(), {
      signal: ctrl.signal, headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const lines = [];
    for (const item of data || []){
      const g = item.geojson;
      if (!g) continue;
      const push = (line) => lines.push(line.map(c => [c[0], c[1]]));
      if (g.type === 'LineString') push(g.coordinates);
      else if (g.type === 'MultiLineString') g.coordinates.forEach(push);
      else if (g.type === 'Polygon') g.coordinates.forEach(push);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(push));
    }
    return lines;
  } finally {
    clearTimeout(timer);
  }
}

function mergeSegments(segs){
  const rest = segs.filter(s => Array.isArray(s) && s.length >= 2);
  if (!rest.length) return { ring: null, closed: false, rest: [], lengthM: 0 };
  rest.sort((a, b) => b.length - a.length);
  const ring = rest.shift().slice();
  let lengthM = lineLength(ring);
  let closed = false;
  const GAP_M = 150;
  while (rest.length){
    if (lengthM > 95000 && haversine(ring[ring.length - 1], ring[0]) < GAP_M){ closed = true; break; }
    const end = ring[ring.length - 1];
    let idx = -1, rev = false, best = Infinity;
    for (let i = 0; i < rest.length; i++){
      const s = rest[i];
      const d1 = haversine(end, s[0]);
      if (d1 < best){ best = d1; idx = i; rev = false; }
      const d2 = haversine(end, s[s.length - 1]);
      if (d2 < best){ best = d2; idx = i; rev = true; }
    }
    if (idx === -1 || best > GAP_M) break;
    const s = rest.splice(idx, 1)[0];
    const ordered = rev ? s.slice().reverse() : s;
    let prev = ring[ring.length - 1];
    for (let i = 1; i < ordered.length; i++){
      ring.push(ordered[i]);
      lengthM += haversine(prev, ordered[i]);
      prev = ordered[i];
    }
  }
  if (!closed && lengthM > 95000 && haversine(ring[ring.length - 1], ring[0]) < GAP_M) closed = true;
  return { ring, closed, rest, lengthM };
}

function setState(lines, polygon, source){
  const all = (Array.isArray(lines) && lines.length)
    ? lines.concat([MKAD_FALLBACK_RING])
    : [MKAD_FALLBACK_RING];
  state = { lines: all, polygon, source, drawingRing: ringClosed(polygon) };
  return state;
}

function ringClosed(ring){
  if (!ring || ring.length < 3) return null;
  const first = ring[0], last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

/* ---------- Километровая параметризация кольца ---------- */
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
function segLenKm(i){
  const next = i + 1 < cum.length ? cum[i + 1] : ringLenKm;
  return next - cum[i];
}
function projectOnSeg(p, a, b){
  const kx = Math.cos(p[1] * Math.PI / 180);
  const ax = a[0] * kx, ay = a[1], bx = b[0] * kx, by = b[1], px = p[0] * kx, py = p[1];
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { point, t, dist: haversine(p, point) };
}
function nearestOnKmRing(p){
  ensureCum();
  let best = { dist: Infinity, t: 0 };
  for (let i = 0; i < MKAD_FALLBACK_RING.length; i++){
    const a = MKAD_FALLBACK_RING[i];
    const b = MKAD_FALLBACK_RING[(i + 1) % MKAD_FALLBACK_RING.length];
    const r = projectOnSeg(p, a, b);
    if (r.dist < best.dist) best = { dist: r.dist, t: cum[i] + r.t * segLenKm(i) };
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
  const f = segLenKm(i) > 0 ? (tt - cum[i]) / segLenKm(i) : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
function dirAtKm(t){
  const p1 = pointAtKm(t), p2 = pointAtKm(t + 0.05);
  const kx = Math.cos(p1[1] * Math.PI / 180);
  const dx = (p2[0] - p1[0]) * kx, dy = p2[1] - p1[1];
  const L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
}

/* Точка въезда/съезда + направление движения нужной стороны МКАД.
   Внутренняя сторона едет по часовой (км растёт), внешняя — против (км убывает).
   role: 'start' (старт с МКАД) или 'end' (финиш на МКАД). */
export function mkadAccessPoint(address, inside, role){
  const { t } = nearestOnKmRing(address);
  let ts;
  if (role === 'start') ts = inside ? t - SHIFT_KM : t + SHIFT_KM;
  else ts = inside ? t + SHIFT_KM : t - SHIFT_KM;

  const P = pointAtKm(ts);

  // Направление движения выбранной стороны в точке ts:
  // внутренняя -> вперёд по км, внешняя -> назад по км
  const ahead = inside ? pointAtKm(ts + 0.05) : pointAtKm(ts - 0.05);
  const bearingDeg = bearingBetween(P, ahead);

  // Боковое смещение к стороне адреса (внешняя/внутренняя)
  const d = dirAtKm(ts);
  const n = [-d[1], d[0]];
  const kx = Math.cos(P[1] * Math.PI / 180);
  const ax = (address[0] - P[0]) * kx, ay = address[1] - P[1];
  const sign = (n[0] * ax + n[1] * ay) >= 0 ? 1 : -1;
  const point = [
    P[0] + sign * n[0] * SIDE_OFFSET_M / (111320 * kx),
    P[1] + sign * n[1] * SIDE_OFFSET_M / 110540
  ];
  return { point, bearingDeg };
}

// Азимут (градусы по часовой от севера) из точки a в точку b
function bearingBetween(a, b){
  const kx = Math.cos(a[1] * Math.PI / 180);
  const east = (b[0] - a[0]) * kx;
  const north = b[1] - a[1];
  return Math.round((Math.atan2(east, north) * 180 / Math.PI + 360) % 360);
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