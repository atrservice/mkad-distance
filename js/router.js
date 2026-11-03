const OSRM = 'https://router.project-osrm.org'; // демо-сервер; для продакшена заменить
// Флаг поддержки exclude: демо-сервер OSRM не поддерживает exclude=toll (возвращает 400).
// Переключите на true, когда используете сервер с поддержкой exclude
// (например, https://routing.openstreetmap.de/routed-car/).
const USE_EXCLUDE = false;

// points: массив [lon, lat].
// bearings: массив той же длины:
//   - null или undefined (без ограничения),
//   - число (градусы направления движения, допуск ±45°),
//   - объект {bearing: число, tolerance: число} (явное указание допуска в градусах).
// exclude: массив строк, например ['toll'] — OSRM избегает указанных классов дорог
export async function buildRoute(points, bearings, exclude){
  if (!Array.isArray(points) || points.length < 2){
    throw new Error('Нужно минимум две точки маршрута');
  }
  const coords = points.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join(';');
  let base = OSRM + '/route/v1/driving/' + coords +
    '?overview=full&geometries=geojson&steps=false&annotations=false&alternatives=false&generate_hints=false';
  if (USE_EXCLUDE && Array.isArray(exclude) && exclude.length){
    base += '&exclude=' + exclude.join(',');
  }

const hasBearings = Array.isArray(bearings) && bearings.some(b => b !== null && b !== undefined);
let url = base;
if (hasBearings){
  const bearStr = bearings.map(b => {
    if (b === null || b === undefined) return '';
    if (typeof b === 'object' && b.bearing != null){
      return b.bearing + ',' + (b.tolerance || 90);
    }
    // Числовой формат: допуск по умолчанию ±90° (возврат к прежнему значению)
    return b + ',90';
  }).join(';');
  url += '&bearings=' + bearStr;
  console.info('buildRoute bearings:', bearStr);
}

  try {
    return await request(url);
  } catch (e){
    // Если OSRM вдруг отверг bearings — повторяем без них, чтобы расчёт не падал
    if (hasBearings){
      console.warn('OSRM отверг bearings, повтор без них:', e.message);
      // При повторе сохраняем exclude (платные дороги — независимый параметр)
      return await request(base);
    }
    throw e;
  }
}

async function request(url){
  const res = await fetch(url);
  if (!res.ok){
    // При 429 (Too Many Requests) ждём 2 секунды и повторяем один раз
    if (res.status === 429){
      console.warn('OSRM вернул 429, повтор через 2с...');
      await new Promise(r => setTimeout(r, 2000));
      const res2 = await fetch(url);
      if (!res2.ok) throw new Error('Сервис маршрутов: HTTP ' + res2.status);
      const data2 = await res2.json();
      if (data2.code !== 'Ok' || !data2.routes || !data2.routes.length){
        throw new Error(routeErrorMessage(data2.code));
      }
      const r2 = data2.routes[0];
      return {
        distanceM: r2.distance,
        durationS: r2.duration,
        legs: r2.legs,
        geometry: r2.geometry.coordinates
      };
    }
    throw new Error('Сервис маршрутов: HTTP ' + res.status);
  }
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes || !data.routes.length){
    throw new Error(routeErrorMessage(data.code));
  }
  const r = data.routes[0];
  return {
    distanceM: r.distance,
    durationS: r.duration,
    legs: r.legs,
    geometry: r.geometry.coordinates
  };
}

function routeErrorMessage(code){
  switch (code){
    case 'NoRoute':   return 'Не удалось построить маршрут по дорогам между точками.';
    case 'NoSegment': return 'Одна из точек недоступна по дорогам.';
    case 'TooBig':    return 'Слишком много точек в маршруте.';
    default:          return 'Ошибка сервиса маршрутов (' + (code || 'неизвестная') + ').';
  }
}