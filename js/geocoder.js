import { DADATA_TOKEN } from './config.js';
import { haversine } from './geo.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const DADATA_SUGGEST = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';
const MSK_CENTER = [37.62, 55.75];
const MIN_INTERVAL_MS = 1100; // ограничение Nominatim: не более 1 запроса/сек

let lastRequestAt = 0;
let chain = Promise.resolve();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function throttledFetch(url, signal){
  const run = chain.then(async () => {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const res = await fetch(url, { signal, headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('Геокодер: HTTP ' + res.status);
    return res.json();
  });
  chain = run.catch(() => {});
  return run;
}

function withTimeout(promise, ms){
  const safe = promise.catch(e => {
    if (e.name === 'AbortError') throw e;
    return [];
  });
  return Promise.race([safe, new Promise(res => setTimeout(() => res([]), ms))]);
}

/* ПОДСКАЗКИ АДРЕСОВ.
   - DADATA_TOKEN пустой  -> только Nominatim (поведение как в начале проекта).
   - DADATA_TOKEN задан   -> Dadata (Москва + область параллельно, МО по близости к Москве)
                             + Nominatim докидывает ближайшие варианты (если успел за 800 мс). */
export async function searchAddress(query, signal){
  if (DADATA_TOKEN){
    try {
      return await dadataMerged(query, signal);
    } catch (e){
      if (e.name === 'AbortError') throw e;
      console.warn('Dadata недоступна, переходим на Nominatim:', e);
    }
  }
  const noms = await nominatimSearch(query, signal);
  return noms.slice(0, 8).map(r => ({
    ...r,
    title: r.shortName,
    sub: r.name.split(',').map(s => s.trim()).slice(3).join(', ')
  }));
}

async function dadataMerged(query, signal){
  const [msk, mo] = await Promise.all([
    dadataSuggest(query, [{ region: 'Москва' }], 5, signal),
    dadataSuggest(query, [{ region: 'Московская область' }], 6, signal)
  ]);

  // Варианты из МО сортируем по близости к Москве: первыми ближайшие города
  const moSorted = mo
    .map(r => ({ r, d: haversine(MSK_CENTER, [r.lon, r.lat]) }))
    .sort((a, b) => a.d - b.d)
    .map(x => x.r);

  const merged = [];
  const push = (r) => {
    if (merged.length >= 10) return;
    const dup = merged.some(m => haversine([m.lon, m.lat], [r.lon, r.lat]) < 120);
    if (!dup) merged.push(r);
  };
  const n = Math.max(msk.length, moSorted.length);
  for (let i = 0; i < n; i++){
    if (msk[i]) push(msk[i]);
    if (moSorted[i]) push(moSorted[i]);
  }

  // Nominatim докидывает ближайшие варианты (Путилково и т.п.), если успел
  try {
    const noms = await withTimeout(nominatimSearch(query, signal), 800);
    for (const r of noms){
      if (merged.length >= 10) break;
      const dup = merged.some(m => haversine([m.lon, m.lat], [r.lon, r.lat]) < 120);
      if (!dup){
        merged.push({
          name: r.name, shortName: r.shortName, lon: r.lon, lat: r.lat,
          title: r.shortName,
          sub: r.name.split(',').map(s => s.trim()).slice(3).join(', ')
        });
      }
    }
  } catch (e){ /* не критично */ }
  return merged;
}

async function dadataSuggest(query, locations, count, signal){
  const res = await fetch(DADATA_SUGGEST, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': 'Token ' + DADATA_TOKEN
    },
    body: JSON.stringify({ query, count, locations }),
    signal
  });
  if (!res.ok) throw new Error('Dadata: HTTP ' + res.status);
  const data = await res.json();
  const out = [];
  for (const s of data.suggestions || []){
    const d = s.data;
    if (d && d.geo_lat && d.geo_lon){
      out.push({
        name: s.value,
        shortName: s.value,
        title: s.value,
        sub: '',
        lat: parseFloat(d.geo_lat),
        lon: parseFloat(d.geo_lon)
      });
    }
  }
  return out;
}

/* Прежний Nominatim-поиск (как в начале проекта): bias на Москву и область */
async function nominatimSearch(query, signal){
  const params = new URLSearchParams({
    format: 'jsonv2', q: query, limit: '6',
    'accept-language': 'ru', countrycodes: 'ru', dedupe: '1',
    viewbox: '36.4,56.3,38.6,55.1', bounded: '0'
  });
  const data = await throttledFetch(NOMINATIM + '?' + params.toString(), signal);
  return (Array.isArray(data) ? data : []).map(item => ({
    name: item.display_name,
    shortName: (item.display_name || '').split(',').map(s => s.trim()).slice(0, 3).join(', '),
    lon: parseFloat(item.lon),
    lat: parseFloat(item.lat)
  }));
}

/* Координаты -> адрес (для ввода координат в десятичном виде) */
export async function reverseGeocode(lat, lon, signal){
  const params = new URLSearchParams({
    format: 'jsonv2', lat: String(lat), lon: String(lon),
    'accept-language': 'ru', zoom: '18'
  });
  try {
    const data = await throttledFetch(NOMINATIM_REVERSE + '?' + params.toString(), signal);
    if (data && data.display_name) return data.display_name;
  } catch (e){
    if (e.name === 'AbortError') throw e;
  }
  return 'Точка ' + lat.toFixed(6) + ', ' + lon.toFixed(6);
}