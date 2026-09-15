import { searchAddress, reverseGeocode } from './geocoder.js';
import { buildRoute } from './router.js';
import { ensureMKAD, loadMkadStatic, mkadAccessPoint, isInsideMKAD, getMKAD, mkadRingForMap } from './mkad.js';
import { haversine } from './geo.js';
import { VEHICLES } from './vehicles.js';

/* ---------- Элементы ---------- */
const $ = (s) => document.querySelector(s);
const addrList = $('#addrList');
const plateCard = $('#plateCard');
const plateDistance = $('#plateDistance');
const plateStatus = $('#plateStatus');
const plateDuration = $('#plateDuration');
const legsCard = $('#legsCard');
const legsList = $('#legsList');
const vehicleInput = $('#vehicleInput');
const vehicleSuggest = $('#vehicleSuggest');
const specsForm = $('#specsForm');
const toastEl = $('#toast');
const installBtn = $('#installBtn');
const helpBtn = $('#helpBtn');
const helpDialog = $('#helpDialog');
const helpClose = $('#helpClose');
const returnToggle = $('#returnToggle');
const netWarn = document.getElementById('netWarn');
const netWarnClose = document.getElementById('netWarnClose');

/* ---------- Карта ---------- */
const map = L.map('map', { zoomControl: true }).setView([55.72, 37.62], 10);
map.attributionControl.setPrefix(false); // убираем "Leaflet | флаг", оставляем © OSM
const tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);
const routeLayer = L.featureGroup().addTo(map);
let mkadRingLayer = null;

/* ---------- Состояние ---------- */
let rows = [];
let rowId = 0;
let recalcTimer = null;
let calcSeq = 0;
let deferredInstall = null;
let selectedVehicleId = null;
const specValues = {};
const routeCache = new Map();

/* ---------- Утилиты ---------- */
const kmFmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtKm = (meters) => kmFmt.format(meters / 1000) + ' км';

function fmtDur(seconds){
  const totalMin = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? h + ' ч ' + m + ' мин' : m + ' мин';
}
function toast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 4000);
    /* Предупреждение о недоступности сервисов (типично при включённом VPN) */
  let netWarnShown = false;
  let tileErrorCount = 0;
  function showNetWarning(){
    if (netWarnShown || !netWarn) return;
    netWarnShown = true;
    netWarn.hidden = false;
  }
  tileLayer.on('tileerror', () => {
    tileErrorCount++;
    if (tileErrorCount >= 3) showNetWarning();
  });
  if (netWarnClose){
    netWarnClose.addEventListener('click', () => { netWarn.hidden = true; });
  }
}

/* ---------- Строки адресов ---------- */
function createRow(){
  const id = ++rowId;
  const row = { id, latlon: null, inside: null, seq: 0, ctrl: null, timer: null };

  const wrap = document.createElement('div');
  wrap.className = 'addr-row';
  const num = document.createElement('div');
  num.className = 'addr-num';
  const field = document.createElement('div');
  field.className = 'addr-field';
  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.enterKeyHint = 'search';
  input.placeholder = 'Адрес или координаты (55.756, 37.617)';
  const suggest = document.createElement('div');
  suggest.className = 'suggest';
  suggest.hidden = true;
  const meta = document.createElement('div');
  meta.className = 'addr-meta';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'addr-del';
  del.setAttribute('aria-label', 'Удалить адрес');
  del.textContent = '×';

  field.append(input, suggest, meta);
  wrap.append(num, field, del);
  addrList.append(wrap);

  row.wrap = wrap; row.num = num; row.input = input;
  row.suggest = suggest; row.meta = meta;

  input.addEventListener('input', () => {
    const wasConfirmed = !!row.latlon;
    row.latlon = null;
    updateRowInside(row);
    updateGhostStates();
    clearTimeout(row.timer);
    row.timer = setTimeout(() => fetchSuggestions(row), 400);
    if (wasConfirmed) scheduleRecalc();
  });
  input.addEventListener('keydown', (e) => onSuggestKeys(row, e));
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (!suggest.contains(document.activeElement)) hideSuggest(row);
    }, 150);
  });
  del.addEventListener('click', () => removeRow(row));

  rows.push(row);
  renumber();
  updateGhostStates();
  return row;
}

function removeRow(row){
  row.wrap.remove();
  rows = rows.filter(r => r !== row);
  ensureGhost();
  renumber();
  updateGhostStates();
  scheduleRecalc();
}
function ensureGhost(){
  if (!rows.length){ createRow(); return null; }
  const last = rows[rows.length - 1];
  if (last.latlon) return createRow();
  return null;
}
function renumber(){ rows.forEach((r, i) => { r.num.textContent = String(i + 1); }); }
function updateGhostStates(){
  rows.forEach((r, i) => {
    const ghost = (i === rows.length - 1) && !r.latlon && r.input.value.trim() === '';
    r.wrap.classList.toggle('is-ghost', ghost);
  });
}

/* ---------- Подсказки адресов и координат ---------- */
function parseCoords(str){
  const m = str.trim().match(/^(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (!isFinite(a) || !isFinite(b)) return null;
  const latOk = (v) => v >= 54.5 && v <= 57.0;
  const lonOk = (v) => v >= 35.5 && v <= 39.5;
  if (latOk(a) && lonOk(b)) return { lat: a, lon: b };
  if (lonOk(a) && latOk(b)) return { lat: b, lon: a };
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b };
  return null;
}

async function fetchSuggestions(row){
  const q = row.input.value.trim();
  row.seq++;
  const my = row.seq;
  if (row.ctrl) row.ctrl.abort();
  if (q.length < 3){ hideSuggest(row); return; }

  const coords = parseCoords(q);
  row.ctrl = new AbortController();
  row.suggest.textContent = '';
  row.suggest.append(makeSuggestItem('Ищем…', null, true));
  row.suggest.hidden = false;

  try {
    if (coords){
      const name = await reverseGeocode(coords.lat, coords.lon, row.ctrl.signal);
      if (row.seq !== my) return;
      row.suggest.textContent = '';
      const item = makeSuggestItem(name, 'Точка с координатами ' + coords.lat.toFixed(6) + ', ' + coords.lon.toFixed(6));
      item.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        confirmRow(row, [coords.lon, coords.lat], row.input.value.trim());
      });
      row.suggest.append(item);
      row.suggest.hidden = false;
      return;
    }
    const results = await searchAddress(q, row.ctrl.signal);
    if (row.seq !== my) return;
    row.suggest.textContent = '';
    if (!results.length){
      row.suggest.append(makeSuggestItem('Ничего не найдено. Уточните адрес.', null, true));
    } else {
      results.forEach(r => {
        const item = makeSuggestItem(r.title, r.sub || '');
        item.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          confirmRow(row, [r.lon, r.lat], r.shortName);
        });
        row.suggest.append(item);
      });
    }
    row.suggest.hidden = false;
  } catch (err){
    if (err.name === 'AbortError' || row.seq !== my) return;
    showNetWarning();
    row.suggest.textContent = '';
    row.suggest.append(makeSuggestItem('Не удалось проверить адрес. Проверьте интернет (при включённом VPN — отключите его).', null, true));
    row.suggest.hidden = false;
  }
}

function confirmRow(row, lonlat, label){
  if (row.ctrl) row.ctrl.abort();
  row.latlon = lonlat;
  row.input.value = label;
  hideSuggest(row);
  updateRowInside(row);
  const added = ensureGhost();
  renumber();
  updateGhostStates();
  scheduleRecalc();
  if (added) added.input.focus();
}

function makeSuggestItem(title, sub, muted){
  const div = document.createElement('div');
  div.className = 'suggest-item' + (muted ? ' muted' : '');
  const t = document.createElement('span');
  t.className = 'suggest-title';
  t.textContent = title;
  div.append(t);
  if (sub){
    const s = document.createElement('span');
    s.className = 'suggest-sub';
    s.textContent = sub;
    div.append(s);
  }
  return div;
}
function hideSuggest(row){ row.suggest.hidden = true; }
function onSuggestKeys(row, e){
  if (row.suggest.hidden) return;
  const items = [...row.suggest.querySelectorAll('.suggest-item:not(.muted)')];
  if (!items.length) return;
  let idx = items.findIndex(i => i.classList.contains('active'));
  if (e.key === 'ArrowDown'){ e.preventDefault(); setActive(items, (idx + 1) % items.length); }
  else if (e.key === 'ArrowUp'){ e.preventDefault(); setActive(items, (idx - 1 + items.length) % items.length); }
  else if (e.key === 'Enter'){ e.preventDefault(); (idx >= 0 ? items[idx] : items[0]).dispatchEvent(new Event('pointerdown')); }
  else if (e.key === 'Escape'){ hideSuggest(row); }
}
function setActive(items, idx){
  items.forEach(i => i.classList.remove('active'));
  items[idx].classList.add('active');
  items[idx].scrollIntoView({ block: 'nearest' });
}

/* ---------- Внутри/снаружи МКАД ---------- */
function updateRowInside(row){
  if (!row.latlon){
    row.inside = null;
    row.meta.textContent = row.input.value.trim().length >= 3 ? 'Выберите адрес из подсказок' : '';
    row.meta.dataset.state = 'empty';
    return;
  }
  row.inside = isInsideMKAD(row.latlon);
  if (row.inside === null){
    row.meta.textContent = 'Определяем положение относительно МКАД…';
    row.meta.dataset.state = 'pending';
  } else {
    row.meta.textContent = row.inside ? 'Внутри МКАД' : 'Снаружи МКАД';
    row.meta.dataset.state = row.inside ? 'in' : 'out';
  }
}

/* ---------- Контур МКАД и готовность схемы ---------- */
function drawMkadRing(){
  if (mkadRingLayer){ mkadRingLayer.remove(); mkadRingLayer = null; }
  const ring = mkadRingForMap();
  if (ring){
    mkadRingLayer = L.polyline(ring.map(p => [p[1], p[0]]), {
      color: '#98a2b3', weight: 2, dashArray: '6 8', opacity: .55, interactive: false
    }).addTo(map);
  }
}
function onMkadReady(){
  const st = getMKAD();
  if (!st) return;
  drawMkadRing();
  rows.forEach(r => { if (r.latlon) updateRowInside(r); });
}

/* ---------- Переключатель «Возврат на МКАД» ---------- */
/* Блокируется и игнорируется, если последний подтверждённый адрес внутри МКАД */
function updateReturnToggle(){
  const used = confirmedPrefix();
  const lastInside = used.length ? isInsideMKAD(used[used.length - 1].latlon) === true : false;
  returnToggle.disabled = lastInside;
  const wrap = returnToggle.closest('.toggle');
  if (wrap) wrap.classList.toggle('is-disabled', lastInside);
  const hint = document.getElementById('returnToggleHint');
  if (hint){
    hint.textContent = lastInside
      ? 'Последний адрес внутри МКАД — возврат к МКАД не рассчитывается'
      : '';
  }
}

/* ---------- Пересчёт пробега ---------- */
function scheduleRecalc(){
  clearTimeout(recalcTimer);
  recalcTimer = setTimeout(recalc, 250);
}
function confirmedPrefix(){
  const used = [];
  for (const r of rows){
    if (r.latlon) used.push(r); else break;
  }
  return used;
}
function routeCacheKey(pts){
  return pts.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join('|');
}

async function recalc(){
  const seq = ++calcSeq;
  const used = confirmedPrefix();
  updateReturnToggle();

  if (!used.length){
    plateCard.dataset.state = 'idle';
    plateDistance.textContent = '—';
    plateStatus.textContent = 'Введите адрес — пробег посчитается автоматически';
    plateDuration.textContent = '';
    legsCard.hidden = true;
    routeLayer.clearLayers();
    return;
  }

  plateCard.dataset.state = 'loading';
  plateStatus.textContent = 'Пересчитываем… Адресов: ' + used.length;

  try {
    const first = used[0].latlon;
    const last = used[used.length - 1].latlon;
    const firstInside = isInsideMKAD(first) === true;
    const lastInside = isInsideMKAD(last) === true;
    const needStart = !firstInside;                          // первый внутри МКАД -> старт с адреса (0 км)
    const needReturn = !lastInside && returnToggle.checked;  // внутри МКАД возврат игнорируется даже при включённом тумблере

    // endShiftKm: сдвиг точки финиша вдоль стороны МКАД.
    // Кандидат A (-0.3) — чуть до ближайшей точки, чтобы не проезжать рампу;
    // кандидат B (+0.5) — с запасом после (гарантия достижимости без разворота).
    const buildPlan = (endShiftKm) => {
      const pts = [], bearings = [], labels = [], mkadPts = [];
      if (needStart){
        const acc = mkadAccessPoint(first, firstInside, 'start', 0.4);
        pts.push(acc.point); bearings.push(acc.bearingDeg);
        labels.push('МКАД'); mkadPts.push(acc.point);
      }
      used.forEach((r, i) => {
        pts.push(r.latlon); bearings.push(null);
        labels.push('Адрес ' + (i + 1));
      });
      if (needReturn){
        const acc = mkadAccessPoint(last, lastInside, 'end', endShiftKm);
        pts.push(acc.point); bearings.push(acc.bearingDeg);
        labels.push('МКАД');
        if (!mkadPts.some(p => p[0] === acc.point[0] && p[1] === acc.point[1])){
          mkadPts.push(acc.point);
        }
      }
      return { pts, bearings, labels, mkadPts };
    };

    const fetchRoute = async (pl) => {
      const key = routeCacheKey(pl.pts) + '|' + pl.bearings.map(b => (b === null ? '' : b)).join(';');
      let r = routeCache.get(key);
      if (!r){
        r = await buildRoute(pl.pts, pl.bearings);
        routeCache.set(key, r);
        if (routeCache.size > 60) routeCache.delete(routeCache.keys().next().value);
      }
      return r;
    };

    const planA = buildPlan(-0.3);

    // Нет ни выезда, ни возврата (например, одиночный адрес внутри МКАД): 0 км
    if (planA.pts.length < 2){
      if (seq !== calcSeq) return;
      plateCard.dataset.state = 'ok';
      plateDistance.textContent = fmtKm(0);
      plateDuration.textContent = '';
      plateStatus.textContent = 'Без выезда и возврата к МКАД — 0 км';
      legsCard.hidden = true;
      drawAddressesOnly(used.map(r => r.latlon));
      return;
    }

    // Есть возврат — считаем двух кандидатов параллельно и берём короткий маршрут
    const plans = needReturn ? [planA, buildPlan(0.5)] : [planA];
    const routes = await Promise.all(plans.map(fetchRoute));
    let idx = 0;
    for (let i = 1; i < routes.length; i++){
      if (routes[i].distanceM < routes[idx].distanceM) idx = i;
    }
    let plan = plans[idx];
    let route = routes[idx];

    // Предохранитель от петель-крюков
    const geoSum = plan.pts.reduce((acc, p, i) => (i ? acc + haversine(plan.pts[i - 1], p) : 0), 0);
    if (route.distanceM > geoSum + 4000){
      const planC = buildPlan(0.9);
      const routeC = await fetchRoute(planC);
      if (routeC.distanceM < route.distanceM){
        plan = planC;
        route = routeC;
      }
    }
    if (seq !== calcSeq) return;

    plateCard.dataset.state = 'ok';
    plateDistance.textContent = fmtKm(route.distanceM);
    plateDuration.textContent = '≈ ' + fmtDur(route.durationS);
    const startTxt = needStart ? 'учтён выезд к МКАД' : 'старт с адреса 1 (внутри МКАД)';
    const endTxt = needReturn ? 'учтён возврат к МКАД'
      : (lastInside ? 'возврат не рассчитывается (последний адрес внутри МКАД)'
                    : 'возврат выключен переключателем');
    plateStatus.textContent = 'Адресов: ' + used.length + ' · ' + startTxt + ', ' + endTxt;

    renderLegs(route.legs, plan.labels);
    // Маркеры МКАД ставим в фактические концы маршрута — точка всегда совпадает с линией
    const geom = route.geometry;
    const mkadDraw = [];
    if (needStart) mkadDraw.push(geom[0]);
    if (needReturn) mkadDraw.push(geom[geom.length - 1]);
    drawOnMap(route.geometry, mkadDraw, used.map(r => r.latlon));
  } catch (err){
    if (seq !== calcSeq) return;
    console.error(err);
    showNetWarning();
    plateCard.dataset.state = 'error';
    plateStatus.textContent = err.message || 'Не удалось рассчитать маршрут';
    plateDuration.textContent = '';
  }
}

function renderLegs(legs, labels){
  legsList.textContent = '';
  legs.forEach((leg, i) => {
    const li = document.createElement('li');
    li.className = 'leg';
    const from = document.createElement('span'); from.className = 'leg-point'; from.textContent = labels[i];
    const arrow = document.createElement('span'); arrow.className = 'leg-arrow'; arrow.textContent = '→';
    const to = document.createElement('span'); to.className = 'leg-point'; to.textContent = labels[i + 1];
    const km = document.createElement('b'); km.textContent = fmtKm(leg.distance);
    const dur = document.createElement('span'); dur.className = 'muted'; dur.textContent = fmtDur(leg.duration);
    li.append(from, arrow, to, km, dur);
    legsList.append(li);
  });
  legsCard.hidden = false;
}

function drawAddressesOnly(addrPts){
  routeLayer.clearLayers();
  addrPts.forEach((p, i) => {
    const icon = L.divIcon({
      className: 'pin',
      html: '<div class="pin-bubble">' + (i + 1) + '</div>',
      iconSize: [28, 28], iconAnchor: [14, 14]
    });
    L.marker([p[1], p[0]], { icon })
      .bindTooltip('Адрес ' + (i + 1), { direction: 'top' })
      .addTo(routeLayer);
  });
  const bounds = routeLayer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
}

function drawOnMap(geometry, mkadPts, addrPts){
  routeLayer.clearLayers();
  L.polyline(geometry.map(p => [p[1], p[0]]), {
    color: '#1c5ede', weight: 5, opacity: .85, lineJoin: 'round'
  }).addTo(routeLayer);
  mkadPts.forEach(p => {
    L.circleMarker([p[1], p[0]], {
      radius: 8, color: '#d92d20', weight: 3, fillColor: '#ffffff', fillOpacity: 1
    }).bindTooltip('Точка на МКАД — ближайший съезд', { direction: 'top' }).addTo(routeLayer);
  });
  addrPts.forEach((p, i) => {
    const icon = L.divIcon({
      className: 'pin',
      html: '<div class="pin-bubble">' + (i + 1) + '</div>',
      iconSize: [28, 28], iconAnchor: [14, 14]
    });
    L.marker([p[1], p[0]], { icon })
      .bindTooltip('Адрес ' + (i + 1), { direction: 'top' })
      .addTo(routeLayer);
  });
  const bounds = routeLayer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
}

/* ---------- Выбор техники ---------- */
function initVehiclePicker(){
  vehicleInput.addEventListener('focus', () => showVehicles(vehicleInput.value.trim()));
  vehicleInput.addEventListener('input', () => showVehicles(vehicleInput.value.trim()));
  vehicleInput.addEventListener('keydown', onVehicleKeys);
  vehicleInput.addEventListener('blur', () => {
    setTimeout(() => {
      vehicleSuggest.hidden = true;
      const sel = VEHICLES.find(v => v.id === selectedVehicleId);
      vehicleInput.value = sel ? sel.name : '';
    }, 150);
  });
}
function showVehicles(filter){
  vehicleSuggest.textContent = '';
  const f = (filter || '').toLowerCase();
  const list = VEHICLES.filter(v => v.name.toLowerCase().includes(f));
  if (!list.length){
    vehicleSuggest.append(makeSuggestItem('Не найдено', null, true));
  } else {
    list.forEach(v => {
      const item = makeSuggestItem(v.name, null, false);
      if (v.id === selectedVehicleId) item.classList.add('selected');
      item.addEventListener('pointerdown', (e) => { e.preventDefault(); selectVehicle(v); });
      vehicleSuggest.append(item);
    });
  }
  vehicleSuggest.hidden = false;
}
function selectVehicle(v){
  selectedVehicleId = v.id;
  vehicleInput.value = v.name;
  vehicleSuggest.hidden = true;
  renderSpecs(v);
}
function onVehicleKeys(e){
  if (vehicleSuggest.hidden) return;
  const items = [...vehicleSuggest.querySelectorAll('.suggest-item:not(.muted)')];
  if (!items.length) return;
  let idx = items.findIndex(i => i.classList.contains('active'));
  if (e.key === 'ArrowDown'){ e.preventDefault(); setActive(items, (idx + 1) % items.length); }
  else if (e.key === 'ArrowUp'){ e.preventDefault(); setActive(items, (idx - 1 + items.length) % items.length); }
  else if (e.key === 'Enter'){ e.preventDefault(); (idx >= 0 ? items[idx] : items[0]).dispatchEvent(new Event('pointerdown')); }
  else if (e.key === 'Escape'){ vehicleSuggest.hidden = true; }
}
function renderSpecs(v){
  specsForm.textContent = '';
  if (!v) return;
  if (!v.specs || !v.specs.length){
    const p = document.createElement('p');
    p.className = 'specs-empty';
    p.textContent = 'Характеристики для «' + v.name + '» скоро появятся.';
    specsForm.append(p);
    return;
  }
  specValues[v.id] = specValues[v.id] || {};
  v.specs.forEach(spec => {
    const row = document.createElement('div');
    row.className = 'spec-row';
    const label = document.createElement('label');
    label.className = 'spec-label';
    label.textContent = spec.name + (spec.unit ? ', ' + spec.unit : '');
    let control;
    if (spec.type === 'select'){
      control = document.createElement('select');
      const ph = document.createElement('option');
      ph.value = ''; ph.textContent = 'Выберите…';
      control.append(ph);
      (spec.options || []).forEach(o => {
        const op = document.createElement('option');
        op.value = o; op.textContent = o;
        control.append(op);
      });
    } else if (spec.type === 'number'){
      control = document.createElement('input');
      control.type = 'number'; control.inputMode = 'decimal'; control.step = 'any';
      if (spec.unit) control.placeholder = spec.unit;
    } else {
      control = document.createElement('input');
      control.type = 'text';
    }
    control.className = 'spec-control';
    control.id = 'spec-' + v.id + '-' + spec.id;
    label.htmlFor = control.id;
    const saved = specValues[v.id][spec.id];
    if (saved !== undefined && saved !== '') control.value = saved;
    control.addEventListener('change', () => { specValues[v.id][spec.id] = control.value; });
    row.append(label, control);
    specsForm.append(row);
  });
}

/* ---------- Плашка и клавиатура на мобильном ---------- */
document.addEventListener('focusin', (e) => {
  if (e.target instanceof Element && e.target.matches('input, select, textarea')){
    document.body.classList.add('kb-open');
  }
});
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (!document.querySelector('input:focus, select:focus, textarea:focus')){
      document.body.classList.remove('kb-open');
    }
  }, 120);
});

/* ---------- Маркеры «?» (у «Маршрут» и у переключателя) ---------- */
document.querySelectorAll('.help-mark').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    btn.closest('.help-wrap').classList.toggle('open');
  });
});
document.addEventListener('click', (e) => {
  document.querySelectorAll('.help-wrap.open').forEach(w => {
    if (!w.contains(e.target)) w.classList.remove('open');
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape'){
    document.querySelectorAll('.help-wrap.open').forEach(w => w.classList.remove('open'));
  }
});

/* ---------- Установка как приложение (PWA) ---------- */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!deferredInstall){ helpDialog.showModal(); return; }
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
  toast('Приложение установлено');
});
helpBtn.addEventListener('click', () => helpDialog.showModal());
helpClose.addEventListener('click', () => helpDialog.close());
helpDialog.addEventListener('click', (e) => { if (e.target === helpDialog) helpDialog.close(); });

/* ---------- Service Worker ---------- */
if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW:', err));
  });
}

/* ---------- Старт ---------- */
createRow();
initVehiclePicker();
updateReturnToggle();
drawMkadRing();
onMkadReady();
returnToggle.addEventListener('change', scheduleRecalc);
// Быстрая локальная геометрия (файл Яндекса) — доступна сразу
loadMkadStatic().then(() => {
  onMkadReady();
  scheduleRecalc();
});
// Съезды из OSM догружаются фоном и не блокируют интерфейс
ensureMKAD().then(() => {
  onMkadReady();
  scheduleRecalc();
});