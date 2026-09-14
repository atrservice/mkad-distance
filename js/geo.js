// Все координаты в проекте хранятся в порядке [lon, lat] (как в GeoJSON).

const EARTH_R = 6371000; // радиус Земли, м
const toRad = (d) => (d * Math.PI) / 180;

// Расстояние между точками [lon, lat], метры (гаверсинус).
export function haversine(a, b){
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Ближайшая к точке p точка на отрезке a–b (плоская проекция,
// точности достаточно для отрезков в сотни метров).
export function nearestOnSegment(p, a, b){
  const kx = Math.cos(toRad(p[1])); // сжатие долготы к полюсам
  const ax = a[0] * kx, ay = a[1];
  const bx = b[0] * kx, by = b[1];
  const px = p[0] * kx, py = p[1];
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { point, dist: haversine(p, point) };
}

// Ближайшая точка на ломаной.
export function nearestOnLine(line, p){
  let best = null;
  for (let i = 0; i < line.length - 1; i++){
    const r = nearestOnSegment(p, line[i], line[i + 1]);
    if (!best || r.dist < best.dist) best = r;
  }
  return best; // { point: [lon,lat], dist: м } или null
}

// Ближайшая точка среди нескольких ломаных.
export function nearestOnLines(lines, p){
  let best = null;
  for (const line of lines){
    if (!Array.isArray(line) || line.length < 2) continue;
    const r = nearestOnLine(line, p);
    if (r && (!best || r.dist < best.dist)) best = r;
  }
  return best;
}

// Точка внутри полигона? (лучевой метод, кольцо может быть незамкнутым)
export function pointInPolygon(p, ring){
  const x = p[0], y = p[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++){
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Длина ломаной, метры.
export function lineLength(line){
  let s = 0;
  for (let i = 1; i < line.length; i++) s += haversine(line[i - 1], line[i]);
  return s;
}