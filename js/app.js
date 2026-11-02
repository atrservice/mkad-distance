import { searchAddress, reverseGeocode } from './geocoder.js';
import { buildRoute } from './router.js';
import { ensureMKAD, loadMkadStatic, mkadAccessPoint, isInsideMKAD, getMKAD, mkadRingForMap, closestMKADPoint, mkadTravelBearing } from './mkad.js';
import { haversine } from './geo.js';
import { VEHICLES, CHASSIS_LABELS, SHIFT_MODES, SHIFT_DEFAULT, SHIFT_TOOLTIP } from './vehicles.js';

/* ---------- Элементы ---------- */
const $ = (s) => document.querySelector(s);
const addrList = $('#addrList');
const plateCard = $('#plateCard');
const plateDistance = $('#plateDistance');
const plateCaption = $('#plateCaption');
const plateTotalLine = $('#plateTotalLine');
const plateStatus = $('#plateStatus');
const plateDuration = $('#plateDuration');
const legsCard = $('#legsCard');
const legsList = $('#legsList');
const vehicleSelect = $('#vehicleSelect');
const toastEl = $('#toast');
const installBtn = $('#installBtn');
const helpBtn = $('#helpBtn');
const helpDialog = $('#helpDialog');
const helpClose = $('#helpClose');
const returnToggle = $('#returnToggle');
const netWarn = document.getElementById('netWarn');
const netWarnClose = document.getElementById('netWarnClose');
// Стоимость аренды и секции
const rentBtn = $('#rentBtn');
const routeSection = $('#routeSection');
const routeHead = $('#routeHead');
const routeKm = $('#routeKm');
const vehicleSection = $('#vehicleSection');
const vehicleHead = $('#vehicleHead');
const vehicleSummary = $('#vehicleSummary');
const chassisWrap = $('#chassisWrap');
const specWrap = $('#specWrap');
const specLabel = $('#specLabel');
const specTip = $('#specTip');
const specSelect = $('#specSelect');
const shiftSelect = $('#shiftSelect');
const shiftTip = $('#shiftTip');
const pricePlate = $('#pricePlate');
const priceShift = $('#priceShift');
const priceHour = $('#priceHour');
const priceKm = $('#priceKm');
const priceTotal = $('#priceTotal');
const priceVat = $('#priceVat');
const priceNoVat = $('#priceNoVat');
const priceTotalNote = $('#priceTotalNote');
const milesPaid = $('#milesPaid');
const milesTotal = $('#milesTotal');
const vatToggle = $('#vatToggle');
const inclToggle = $('#inclToggle');
const inclKm = $('#inclKm');
const vatRowPct = $('#vatRowPct');
const noVatPct = $('#noVatPct');
const modeCalcBtn = $('#modeCalcBtn');
const modeOrderBtn = $('#modeOrderBtn');
const mapExpandBtn = $('#mapExpand');
const mapBackdrop = $('#mapBackdrop');

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
const routeCache = new Map();
// Стоимость аренды
let appMode = 'route';      // 'route' | 'rent' (в будущем 'order' — «Оформить заказ»)
let lastDistanceM = null;   // общий пробег последнего успешного расчёта (м); при ошибке НЕ меняется
let lastRouteData = null;   // данные геометрии для оплачиваемого пробега; при ошибке НЕ меняется
let rentOption = null;      // выбранный вариант характеристики
let shiftModeId = SHIFT_DEFAULT; // выбранный режим «Смена» (влияет только на сумму, поля не меняет)

/* ---------- Утилиты ---------- */
const kmFmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const rubFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const moneyFmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtKm = (meters) => kmFmt.format(meters / 1000) + ' км';
// Общий и оплачиваемый пробег в показах — ЦЕЛЫЕ км (ноги участков — с десятыми)
const fmtKmWhole = (meters) => Math.round(meters / 1000) + ' км';
const fmtRub = (v) => rubFmt.format(Math.round(v)) + ' ₽';
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
}
/* Проценты из полей UI: нечисловое/отрицательное → fallback */
function pctVal(el, fallback){
  const n = parseFloat(el.value);
  return isFinite(n) && n >= 0 ? n : fallback;
}

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
  const drag = document.createElement('button');
  drag.type = 'button';
  drag.className = 'addr-drag';
  drag.setAttribute('aria-label', 'Переместить адрес');
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'addr-del';
  del.setAttribute('aria-label', 'Удалить адрес');
  del.textContent = '×';
  field.append(input, suggest, meta);
  wrap.append(num, field, drag, del);
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

/* ---------- Перетаскивание адресов (смена порядка) ---------- */
let dragRow = null;
addrList.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.addr-drag');
  if (!handle) return;
  const wrap = handle.closest('.addr-row');
  if (!wrap || wrap.classList.contains('is-ghost')) return; // пустую ghost-строку не таскаем
  e.preventDefault();
  dragRow = wrap;
  wrap.classList.add('is-dragging');
  addrList.classList.add('is-dragging');
  handle.setPointerCapture(e.pointerId);
});
addrList.addEventListener('pointermove', (e) => {
  if (!dragRow) return;
  const after = getDragAfterElement(e.clientY);
  const ghostEl = addrList.querySelector('.addr-row.is-ghost');
  if (after == null){
    // ниже всех: ставим перед ghost-строкой (ghost всегда последняя)
    if (ghostEl && ghostEl !== dragRow) addrList.insertBefore(dragRow, ghostEl);
    else addrList.append(dragRow);
  } else if (after !== dragRow){
    addrList.insertBefore(dragRow, after);
  }
});
addrList.addEventListener('pointerup', finishDrag);
addrList.addEventListener('pointercancel', finishDrag);
function finishDrag(){
  if (!dragRow) return;
  dragRow.classList.remove('is-dragging');
  addrList.classList.remove('is-dragging');
  dragRow = null;
  syncRowsFromDom();
}
/* Строка, ПЕРЕД которой нужно вставить перетаскиваемую: ближайшая сверху от курсора */
function getDragAfterElement(y){
  const els = [...addrList.querySelectorAll('.addr-row:not(.is-dragging)')];
  let closest = null;
  let closestOffset = -Infinity;
  els.forEach(el => {
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset){ closestOffset = offset; closest = el; }
  });
  return closest;
}
/* После броска: порядок массива rows = порядку DOM, затем перенумерация и пересчёт */
function syncRowsFromDom(){
  const order = [...addrList.children].filter(el => el.classList.contains('addr-row'));
  rows.sort((a, b) => order.indexOf(a.wrap) - order.indexOf(b.wrap));
  renumber();
  updateGhostStates();
  scheduleRecalc();
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
    lastDistanceM = null;
    lastRouteData = null;
    updateRouteSummary();
    updatePlateMiles();
    recalcRentTotal();
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
    // Съезд/въезд выбираем ПО ДОРОГАМ (OSRM table); null — ближайший по прямой
    const startPos = needStart ? await probeBestJunction(first, firstInside, 'start') : null;
    const endPos = needReturn ? await probeBestJunction(last, lastInside, 'end') : null;
    if (seq !== calcSeq) return;
    const buildPlan = (endShiftKm) => {
      const pts = [], bearings = [], labels = [], mkadPts = [];
      if (needStart){
        const acc = mkadAccessPoint(first, firstInside, 'start', 0.4, startPos);
        pts.push(acc.point); bearings.push(acc.bearing);
        labels.push('МКАД'); mkadPts.push(acc.point);
      }
      used.forEach((r, i) => {
        pts.push(r.latlon); bearings.push(null);
        labels.push('Адрес ' + (i + 1));
      });
      if (needReturn){
        const acc = mkadAccessPoint(last, lastInside, 'end', endShiftKm, endPos);
        pts.push(acc.point); bearings.push(acc.bearing);
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
      plateDistance.textContent = '0';
      plateDuration.textContent = '';
      plateStatus.textContent = 'Без выезда и возврата к МКАД — 0 км';
      legsCard.hidden = true;
      drawAddressesOnly(used.map(r => r.latlon));
      lastDistanceM = 0;
      lastRouteData = null;
      updateRouteSummary();
      updatePlateMiles();
      recalcRentTotal();
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
    // В #plateDistance — ТОЛЬКО число (единица «км» — отдельный span), целые км
    plateDistance.textContent = String(Math.round(route.distanceM / 1000));
    plateDuration.textContent = '≈ ' + fmtDur(route.durationS);
    const startTxt = needStart ? 'учтён выезд с МКАД' : 'старт с адреса 1 (внутри МКАД)';
    const endTxt = needReturn ? 'учтён возврат на МКАД'
      : (lastInside ? 'возврат не рассчитывается (последний адрес внутри МКАД)'
                    : 'возврат выключен переключателем');
    plateStatus.textContent = 'Адресов: ' + used.length + ' · ' + startTxt + ', ' + endTxt;
    renderLegs(route.legs, plan.labels);
    // Маркеры МКАД ставим в фактические концы геометрии маршрута — точка всегда совпадает с линией
    const geom = route.geometry;
    const mkadDraw = [];
    if (needStart) mkadDraw.push(geom[0]);
    if (needReturn) mkadDraw.push(geom[geom.length - 1]);
    drawOnMap(route.geometry, mkadDraw, used.map(r => r.latlon));
    lastDistanceM = route.distanceM;
    // Данные для ОПЛАЧИВАЕМОГО пробега (типозависимая калькуляция).
    const legPolylines = splitGeometryByWaypoints(route.geometry, plan.pts);
    let outsideDelivery = 0; // подача: МКАД → адрес 1 (только если адрес 1 снаружи)
    let outsideReloc = 0;    // перебазировки: адрес → адрес
    legPolylines.forEach((pl, i) => {
      const fromMkad = plan.labels[i] === 'МКАД';
      const toMkad = plan.labels[i + 1] === 'МКАД';
      if (!fromMkad && !toMkad) outsideReloc += outsideMkadDistance(pl);
      else if (fromMkad && !toMkad) outsideDelivery += outsideMkadDistance(pl);
    });
    lastRouteData = {
      outsideFull: outsideMkadDistance(route.geometry), // манипулятор: всё вне МКАД
      outsideDelivery,
      outsideReloc
    };
    updateRouteSummary();
    updatePlateMiles();
    recalcRentTotal();
  } catch (err){
    if (seq !== calcSeq) return;
    console.error(err);
    showNetWarning();
    plateCard.dataset.state = 'error';
    plateStatus.textContent = err.message || 'Не удалось рассчитать маршрут';
    plateDuration.textContent = '';
    // lastDistanceM и lastRouteData намеренно НЕ меняем при ошибке
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

/* ---------- Оплачиваемый пробег: геометрия вне МКАД ---------- */
function splitGeometryByWaypoints(geometry, pts){
  const legs = [];
  let start = 0;
  for (let k = 1; k < pts.length; k++){
    let bestIdx = start, bestD = Infinity;
    for (let i = start; i < geometry.length; i++){
      const d = haversine(geometry[i], pts[k]);
      if (d < bestD){ bestD = d; bestIdx = i; }
    }
    legs.push(geometry.slice(start, bestIdx + 1));
    start = bestIdx;
  }
  return legs;
}
const MKAD_TOLERANCE_M = 25;
function outsideMkadDistance(pts){
  let total = 0;
  for (let i = 1; i < pts.length; i++){
    const a = pts[i - 1], b = pts[i];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const inside = isInsideMKAD(mid);
    if (inside === true) continue;
    if (inside === null){ total += haversine(a, b); continue; }
    const ringPt = closestMKADPoint(mid);
    if (ringPt && haversine(mid, ringPt) < MKAD_TOLERANCE_M) continue; // сама МКАД
    total += haversine(a, b);
  }
  return total;
}

/* ---------- Выбор съезда ПО ДОРОГАМ, а не по прямой ---------- */
/* Цепочка устойчивости: table+bearings → table без bearings → route-зонд топ-3 → прямая.
   Режим работы пишется в console.info, ошибки — в console.warn: ничего не молчит. */
const junctionProbeCache = new Map();
function probeListFor(st, side, role){
  const all = (st.junctions || []).filter(j => typeof j.idx === 'number');
  if (role === 'start') return all.filter(j => j.side === side && j.type === 'exit');
  // Возврат: въезды ОБЕИХ сторон — ближайший достижимый слив; иначе клеверницы
  // на развязках, когда прямой съезд идёт на встречную сторону (кейс «Кубинка»).
  return all.filter(j => j.type === 'enter');
}
async function tableDistances(coords, sources, destinations, bearEntries){
  const url = 'https://router.project-osrm.org/table/v1/driving/' + coords +
    '?sources=' + sources + '&destinations=' + destinations +
    (bearEntries ? '&bearings=' + bearEntries.join(';') : '');
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.code !== 'Ok' || !Array.isArray(data.distances)){
    console.warn('OSRM table вернул code=' + data.code + ', но без distances:', JSON.stringify(data).slice(0, 200));
    throw new Error('table: ' + data.code);
  }
  return data.distances;
}
function probeAngle(p){
  const C_LON = 37.62, C_LAT = 55.72;
  const kx = Math.cos(C_LAT * Math.PI / 180);
  return Math.atan2(p[1] - C_LAT, (p[0] - C_LON) * kx);
}
function probeAngleDiff(a, b){
  let d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}
async function probeBestJunction(address, inside, role){
  const st = getMKAD();
  const side = inside ? 'inner' : 'outer';
  const list = probeListFor(st, side, role);
  if (list.length < 2) return null;
  // Кандидаты: 4 ближайших ПО ПРЯМОЙ + 4 ближайших ПО СЕКТОРУ (угол от центра Москвы).
  // У дальних адресов дорожно-оптимальный съезд лежит в секторе адреса,
  // но по прямой может быть 5–8-м (Новопетровское → Новорижский).
  const aAddr = probeAngle(address);
  const byDist = list
    .map((j, i) => ({ i, d: haversine(address, [j.lon, j.lat]) }))
    .sort((a, b) => a.d - b.d);
  const byAng = list
    .map((j, i) => ({ i, d: probeAngleDiff(probeAngle([j.lon, j.lat]), aAddr) }))
    .sort((a, b) => a.d - b.d);
  const near = [];
  byDist.slice(0, 4).forEach(x => { if (!near.includes(x.i)) near.push(x.i); });
  byAng.slice(0, 4).forEach(x => { if (!near.includes(x.i)) near.push(x.i); });
  if (near.length < 2) return null;
  const key = role + '|' + address.map(c => c.toFixed(5)).join(',') + '|' + near.join(',');
  if (junctionProbeCache.has(key)) return junctionProbeCache.get(key);
  let best = null;
  let mode = '';
  const cand = near.map(i => list[i].lon + ',' + list[i].lat);
  const addr = address[0] + ',' + address[1];
  const coords = role === 'start' ? cand.concat([addr]).join(';') : [addr].concat(cand).join(';');
  const sources = role === 'start' ? near.map((_, k) => k).join(';') : '0';
  const destinations = role === 'start' ? String(near.length) : near.map((_, k) => k + 1).join(';');
  // Bearings НЕ передаём в table: trailing ';' ломает URL, а для сравнения дистанций
  // направление не критично. Bearings используются только в route-зонде и buildRoute.
  const bearEntries = null;
  let distances = null;
  try {
    distances = await tableDistances(coords, sources, destinations, null);
    mode = 'table';
    } catch (e2){
      console.warn('OSRM table недоступен, включаю route-зонд:', e2);
    }
  
  if (distances){
    let bestK = -1, bestD = Infinity;
    for (let k = 0; k < near.length; k++){
      const d = role === 'start' ? distances[k][0] : distances[0][k];
      if (isFinite(d) && d < bestD){ bestD = d; bestK = k; }
    }
    if (bestK >= 0) best = near[bestK];
  } else {
    // Фолбэк: реальные маршруты ДО ВСЕХ кандидатов (параллельно), берём короткий.
    // Прямой слив без клеверницы выигрывает по дистанции сам (кейс «Кубинка»).
    mode = 'route-probe';
    const res = await Promise.all(near.map(i => {
      const pt = [list[i].lon, list[i].lat];
      const b = mkadTravelBearing(pt, list[i].side);
      const pts = role === 'start' ? [pt, address] : [address, pt];
      const bears = role === 'start'
        ? [{ bearing: b, tolerance: 45 }, null]
        : [null, { bearing: b, tolerance: 45 }];
      return buildRoute(pts, bears).catch(() => null);
    }));
    let bestK = -1, bestD = Infinity;
    res.forEach((r, k) => {
      if (r && isFinite(r.distanceM) && r.distanceM < bestD){ bestD = r.distanceM; bestK = k; }
    });
    // Для возврата: если лучший кандидат даёт петлю (дорожная > прямой + 2 км),
    // используем следующего кандидата (слив по ходу движения, а не против).
    if (bestK >= 0 && role === 'end'){
      const bestPt = [list[near[bestK]].lon, list[near[bestK]].lat];
      const directDist = haversine(address, bestPt);
      if (bestD > directDist + 2000){
        // Ищем следующего кандидата с более коротким маршрутом
        for (let k = 0; k < near.length; k++){
          if (k === bestK) continue;
          const r = res[k];
          if (r && isFinite(r.distanceM)){
            const pt = [list[near[k]].lon, list[near[k]].lat];
            const dirDist = haversine(address, pt);
            if (r.distanceM < directDist + 1500 || r.distanceM < bestD - 1000){
              bestK = k;
              bestD = r.distanceM;
              break;
            }
          }
        }
      }
    }
    if (bestK >= 0) best = near[bestK];
  }
  console.info('MKAD probe (' + role + '): ' + mode + ', кандидатов ' + near.length +
    ', выбран ' + (best == null ? 'null' : list[best].lon + ',' + list[best].lat));
  if (junctionProbeCache.size > 60) junctionProbeCache.delete(junctionProbeCache.keys().next().value);
  junctionProbeCache.set(key, best);
  return best;
}

/* ---------- Франшиза «Включено в смену» ---------- */
/* ВКЛ: оплачиваемый пробег (округлённый, как на экране) НЕ БОЛЬШЕ значения → 0;
   СТРОГО больше → оплачивается ПОЛНОСТЬЮ. ВЫКЛ: оплачивается весь.
   Пример: включено 5, маршрут 5,2 (на экране 5) → 5 <= 5 → не оплачивается. */
function paidKmRaw(v){
  return Math.round(paidDistanceFor(v) / 1000);
}
function paidKmEffective(v){
  const raw = paidKmRaw(v);
  if (!inclToggle.checked) return raw;
  return raw <= pctVal(inclKm, 10) ? 0 : raw;
}

/* ---------- Плашка маршрута: оплачиваемый пробег крупно ---------- */
function updatePlateMiles(){
  const v = VEHICLES.find(x => x.id === selectedVehicleId);
  if (v && lastDistanceM != null){
    plateCaption.hidden = false;
    plateTotalLine.hidden = false;
    plateDistance.textContent = String(paidKmEffective(v));
    plateTotalLine.textContent = 'Общий пробег: ' + fmtKmWhole(lastDistanceM);
  } else {
    plateCaption.hidden = true;
    plateTotalLine.hidden = true;
    plateDistance.textContent = lastDistanceM == null ? '—' : String(Math.round(lastDistanceM / 1000));
  }
}

/* ---------- Выбор техники и стоимость аренды ---------- */
function chassisValue(){
  const r = document.querySelector('input[name="chassis"]:checked');
  return r ? r.value : 'highway';
}
function initVehicleSelect(){
  vehicleSelect.textContent = '';
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = 'Выберите…';
  vehicleSelect.append(ph);
  VEHICLES.forEach(v => {
    const op = document.createElement('option');
    op.value = v.id; op.textContent = v.name;
    vehicleSelect.append(op);
  });
}
function initShiftSelect(){
  shiftSelect.textContent = '';
  SHIFT_MODES.forEach(m => {
    const op = document.createElement('option');
    op.value = m.id; op.textContent = m.id;
    shiftSelect.append(op);
  });
  shiftSelect.value = SHIFT_DEFAULT;
}
vehicleSelect.addEventListener('change', () => {
  const v = VEHICLES.find(x => x.id === vehicleSelect.value) || null;
  selectedVehicleId = v ? v.id : null;
  if (v){
    renderVehicleDetails(v);
  } else {
    rentOption = null;
    chassisWrap.hidden = true;
    specWrap.hidden = true;
    pricePlate.hidden = true;
    updateVehicleSummary();
    updatePlateMiles();
  }
});
function renderVehicleDetails(v){
  rentOption = null;
  pricePlate.hidden = true;
  // Шасси по умолчанию ВСЕГДА «Шоссейное»
  const hw = document.querySelector('input[name="chassis"][value="highway"]');
  if (hw) hw.checked = true;
  chassisWrap.hidden = !v.hasChassis;
  specLabel.textContent = v.specName;
  specTip.textContent = v.specTooltip;
  specSelect.textContent = '';
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = 'Выберите…';
  specSelect.append(ph);
  (v.options || []).forEach(o => {
    const op = document.createElement('option');
    op.value = o; op.textContent = o;
    specSelect.append(op);
  });
  specSelect.value = '';
  shiftModeId = SHIFT_DEFAULT;
  shiftSelect.value = SHIFT_DEFAULT;
  specWrap.hidden = false;
  updateVehicleSummary();
  updatePlateMiles();
}

/* ---------- Режим «Смена», НДС и цены ---------- */
function shiftMode(){
  return SHIFT_MODES.find(m => m.id === shiftModeId) || SHIFT_MODES[0];
}
/* Доп. часы режима СВЕРХ базового 7+1 (8 оплачиваемых часов):
   доп. часы = (work + delivery) − 8, не меньше 0. Поля цен режим НЕ меняет. */
function shiftExtraHours(mode){
  return Math.max(0, mode.work + mode.delivery - 8);
}
function getBasePrices(v, option, chassis){
  const byOption = (v.prices && v.prices[option]) || null;
  if (!byOption) return null;
  return byOption[chassis] || byOption.highway || null;
}
/* Заполняет поля цен базовыми значениями; при включённом «Цена с НДС» —
   база × (1 + ставка из поля «С НДС» / 100). Переключение крыжика, правка ставки,
   смена варианта/шасси сбрасывают ручные правки. */
function fillBasePrices(v, option, chassis){
  const p = getBasePrices(v, option, chassis);
  const mult = vatToggle.checked ? (1 + pctVal(vatRowPct, 22) / 100) : 1;
  shiftModeId = SHIFT_DEFAULT;
  shiftSelect.value = SHIFT_DEFAULT;
  const shift = p ? Math.round(p.shift * mult) : 0;
  priceShift.value = shift;
  priceHour.value = Math.round(shift / 8);
  priceKm.value = p ? Math.round(p.km * mult) : 0;
}
function priceVal(el){
  const n = parseFloat(el.value);
  return isFinite(n) && n > 0 ? n : 0;
}
specSelect.addEventListener('change', () => {
  const v = VEHICLES.find(x => x.id === selectedVehicleId);
  rentOption = specSelect.value || null;
  if (!v || !rentOption){
    pricePlate.hidden = true;
    updateVehicleSummary();
    return;
  }
  fillBasePrices(v, rentOption, chassisValue());
  pricePlate.hidden = false;
  recalcRentTotal();
  updateVehicleSummary();
});
document.querySelectorAll('input[name="chassis"]').forEach(r => {
  r.addEventListener('change', () => {
    const v = VEHICLES.find(x => x.id === selectedVehicleId);
    if (v && rentOption){
      fillBasePrices(v, rentOption, chassisValue());
      recalcRentTotal();
    }
    updateVehicleSummary();
  });
});
// Крыжик «Цена с НДС»: поля цен = база × (1 + q/100) или обратно к базе
vatToggle.addEventListener('change', () => {
  const v = VEHICLES.find(x => x.id === selectedVehicleId);
  if (v && rentOption){
    fillBasePrices(v, rentOption, chassisValue());
    recalcRentTotal();
  }
});
// Правка ставки «С НДС»: при ВКЛ-крыжике переполняем поля от базы с новой ставкой
vatRowPct.addEventListener('input', () => {
  const v = VEHICLES.find(x => x.id === selectedVehicleId);
  if (vatToggle.checked && v && rentOption){
    fillBasePrices(v, rentOption, chassisValue());
  }
  recalcRentTotal();
});
noVatPct.addEventListener('input', recalcRentTotal);
// Франшиза «Включено в смену»: меняет оплачиваемый пробег и строки
inclToggle.addEventListener('change', () => {
  recalcRentTotal();
  updatePlateMiles();
});
inclKm.addEventListener('input', () => {
  recalcRentTotal();
  updatePlateMiles();
});
shiftSelect.addEventListener('change', () => {
  shiftModeId = shiftSelect.value || SHIFT_DEFAULT;
  recalcRentTotal();
  updateVehicleSummary();
});
priceShift.addEventListener('input', () => {
  priceHour.value = Math.round(priceVal(priceShift) / 8);
  recalcRentTotal();
});
[priceHour, priceKm].forEach(inp => inp.addEventListener('input', recalcRentTotal));
// Кнопки «Выбрать» — заглушка до следующей фичи
document.querySelectorAll('.price-choose').forEach(b => {
  b.addEventListener('click', () => {
    toast('Кнопка «Выбрать» — заглушка: выбор варианта расчёта появится в следующей итерации');
  });
});

/* ---------- Типозависимая калькуляция ---------- */
function extraHoursFor(v, nAddr){
  if (nAddr < 2) return 0;
  if (v.id === 'manipulyator') return Math.max(0, nAddr - 2);
  return nAddr - 1;
}
function paidDistanceFor(v){
  if (v.id === 'avtovyshka' || v.id === 'prikrytie') return lastDistanceM || 0;
  if (!lastRouteData) return 0;
  if (v.id === 'manipulyator') return lastRouteData.outsideFull;
  if (v.id === 'avtokran') return lastRouteData.outsideDelivery + lastRouteData.outsideReloc;
  return lastDistanceM || 0;
}
/* ФОРМУЛА: S = смена(7+1) + (доп. часы режима + доп. часы типа) × час
           + Оплачиваемый пробег ПОСЛЕ франшизы (целые км) × цена/км — из текущих полей.
   Ставки из полей UI: q = «С НДС %» (она же — ставка крыжика «Цена с НДС»), p = «Без НДС %».
   Строки БЕЗ двойного НДС:
   - крыжик ВЫКЛ: наличный = S; с НДС = наличный × (1+q/100); без НДС = наличный × (1+p/100);
   - крыжик ВКЛ: наличный = S / (1+q/100); с НДС = наличный × (1+q/100) (= S);
     без НДС = наличный × (1+p/100). */
function recalcRentTotal(){
  const v = VEHICLES.find(x => x.id === selectedVehicleId);
  if (!v || !rentOption) return;
  const shift = priceVal(priceShift);
  const hourRate = priceVal(priceHour);
  const kmRate = priceVal(priceKm);
  const extraMode = shiftExtraHours(shiftMode());
  const extraType = extraHoursFor(v, confirmedPrefix().length);
  const rawPaidKm = paidKmRaw(v);
  const paidKm = paidKmEffective(v);
  const total = shift + (extraMode + extraType) * hourRate + paidKm * kmRate;
  milesTotal.textContent = lastDistanceM == null ? 'не рассчитан' : fmtKmWhole(lastDistanceM);
  milesPaid.textContent = lastDistanceM == null ? '—' : paidKm + ' км';
  const q = pctVal(vatRowPct, 22);
  const p = pctVal(noVatPct, 8);
  const cash = vatToggle.checked ? total / (1 + q / 100) : total;
  priceTotal.textContent = fmtRub(cash);
  priceVat.textContent = moneyFmt.format(cash * (1 + q / 100)) + ' ₽';
  priceNoVat.textContent = moneyFmt.format(cash * (1 + p / 100)) + ' ₽';
  const kmLabel = (v.id === 'avtovyshka' || v.id === 'prikrytie') ? 'пробег' : 'оплачиваемый пробег';
  const typeLabel = v.id === 'avtokran' ? 'перебазировки'
    : v.id === 'manipulyator' ? 'доп. адреса'
    : 'доп. часы';
  const sym = ['смена (' + shiftModeId + ')'];
  const num = [fmtRub(shift)];
  if (extraMode > 0){ sym.push('доп. часы смены (' + extraMode + ' ч)'); num.push(extraMode + ' ч × ' + fmtRub(hourRate)); }
  if (extraType > 0){ sym.push(typeLabel + ' (' + extraType + ' ч)'); num.push(extraType + ' ч × ' + fmtRub(hourRate)); }
  let tail = '';
  if (paidKm > 0){
    sym.push(kmLabel);
    num.push(paidKm + ' км × ' + fmtRub(kmRate) + '/км');
  } else if (rawPaidKm > 0 && inclToggle.checked){
    const inc = pctVal(inclKm, 10);
    tail = ' · пробег ' + rawPaidKm + ' км ' + (rawPaidKm < inc ? 'меньше' : 'равен') +
      ' включённым в смену ' + inc + ' км — не оплачивается';
  }
  const vatNote = vatToggle.checked ? ' · цены в полях с НДС ' + q + '%' : '';
  if (lastDistanceM == null){
    priceTotalNote.textContent = 'Расчет = ' + sym.join(' + ') + ' = ' + num.join(' + ') +
      ' (пробег пока не рассчитан — введите адрес в разделе «Маршрут»)' + vatNote;
  } else {
    priceTotalNote.textContent = 'Расчет = ' + sym.join(' + ') + ' = ' + num.join(' + ') + tail + vatNote;
  }
}
function updateVehicleSummary(){
  const v = VEHICLES.find(x => x.id === selectedVehicleId);
  if (!v){ vehicleSummary.textContent = ''; return; }
  const parts = [v.name];
  if (rentOption) parts.push(rentOption);
  if (v.hasChassis) parts.push(CHASSIS_LABELS[chassisValue()] || 'Шоссейное');
  if (rentOption) parts.push(shiftModeId);
  vehicleSummary.textContent = parts.join(' · ');
}

/* ---------- Секции и режимы (аккордеон «Маршрут» / «Выбор техники») ---------- */
function updateRouteSummary(){
  routeKm.textContent = lastDistanceM == null ? '— км' : fmtKmWhole(lastDistanceM);
}
function setMode(mode){
  if (mode !== 'route' && mode !== 'rent') return;
  appMode = mode;
  const rent = mode === 'rent';
  document.body.classList.toggle('mode-rent', rent);
  routeSection.classList.toggle('is-collapsed', rent);
  vehicleSection.classList.toggle('is-collapsed', !rent);
  routeHead.setAttribute('aria-expanded', String(!rent));
  vehicleHead.setAttribute('aria-expanded', String(rent));
  routeHead.tabIndex = rent ? 0 : -1;
  vehicleHead.tabIndex = rent ? -1 : 0;
  updateVehicleSummary();
  if (rent && document.body.classList.contains('map-full')) setMapFull(false);
  if (rent){
    vehicleSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    requestAnimationFrame(() => map.invalidateSize());
  }
}
rentBtn.addEventListener('click', () => setMode('rent'));
routeHead.addEventListener('click', () => {
  if (routeSection.classList.contains('is-collapsed')) setMode('route');
});
vehicleHead.addEventListener('click', () => {
  if (vehicleSection.classList.contains('is-collapsed')) setMode('rent');
});
[[routeHead, routeSection, () => setMode('route')],
 [vehicleHead, vehicleSection, () => setMode('rent')]].forEach(([head, sec, act]) => {
  head.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && sec.classList.contains('is-collapsed')){
      e.preventDefault();
      act();
    }
  });
});
modeCalcBtn.addEventListener('click', () => setMode('route'));
modeOrderBtn.addEventListener('click', () => {
  toast('Режим «Оформить заказ» появится позже — после введения регистрации');
});

/* ---------- Разворот карты на весь экран (десктоп) ---------- */
function setMapFull(on){
  document.body.classList.toggle('map-full', on);
  mapBackdrop.hidden = !on;
  mapExpandBtn.setAttribute('aria-expanded', String(on));
  mapExpandBtn.setAttribute('aria-label', on ? 'Свернуть карту' : 'Развернуть карту');
  requestAnimationFrame(() => map.invalidateSize());
  setTimeout(() => map.invalidateSize(), 250);
}
mapExpandBtn.addEventListener('click', () => setMapFull(!document.body.classList.contains('map-full')));
mapBackdrop.addEventListener('click', () => setMapFull(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('map-full')) setMapFull(false);
});

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

/* ---------- Маркеры «?» ---------- */
document.addEventListener('click', (e) => {
  const mark = e.target.closest('.help-mark');
  if (mark){
    e.stopPropagation();
    const wrap = mark.closest('.help-wrap');
    const wasOpen = wrap.classList.contains('open');
    document.querySelectorAll('.help-wrap.open').forEach(w => w.classList.remove('open'));
    if (!wasOpen) wrap.classList.add('open');
    return;
  }
  if (e.target.closest('.help-tip a')) return;
  const tip = e.target.closest('.help-tip');
  if (tip){
    e.stopPropagation();
    const wrap = tip.closest('.help-wrap');
    if (wrap) wrap.classList.remove('open');
    return;
  }
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
initVehicleSelect();
initShiftSelect();
shiftTip.textContent = SHIFT_TOOLTIP;
updateReturnToggle();
updateRouteSummary();
updatePlateMiles();
drawMkadRing();
onMkadReady();
returnToggle.addEventListener('change', scheduleRecalc);
loadMkadStatic().then(() => {
  onMkadReady();
  scheduleRecalc();
});
ensureMKAD().then(() => {
  onMkadReady();
  scheduleRecalc();
});