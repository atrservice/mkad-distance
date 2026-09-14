import { DADATA_TOKEN } from './config.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const DADATA_SUGGEST = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';
const MIN_INTERVAL_MS = 1100; // только для Nominatim

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

/* Подсказки адреса: Dadata (быстро), при отсутствии токена/сбое — Nominatim */
export async function searchAddress(query, signal){
  if (DADATA_TOKEN){
    try {
      return await dadataSuggest(query, signal);
    } catch (e){
      if (e.name === 'AbortError') throw e;
      console.warn('Dadata недоступна, переходим на Nominatim:', e);
    }
  }
  return nominatimSearch(query, signal);
}

async function dadataSuggest(query, signal){
  const res = await fetch(DADATA_SUGGEST, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': 'Token ' + DADATA_TOKEN
    },
    body: JSON.stringify({
      query,
      count: 6,
      locations: [{ region: 'Москва' }, { region: 'Московская область' }]
    }),
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
        lat: parseFloat(d.geo_lat),
        lon: parseFloat(d.geo_lon)
      });
    }
  }
  if (!out.length) throw new Error('Dadata: пусто');
  return out;
}

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

/* Координаты -> адрес (редкий случай, остаётся Nominatim) */
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