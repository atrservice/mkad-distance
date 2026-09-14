const OSRM = 'https://router.project-osrm.org'; // демо-сервер; для продакшена заменить

// points: массив [lon, lat].
// bearings: массив той же длины: null (без ограничения) или градусы направления движения в точке.
export async function buildRoute(points, bearings){
  if (!Array.isArray(points) || points.length < 2){
    throw new Error('Нужно минимум две точки маршрута');
  }
  const coords = points.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join(';');
  const base = OSRM + '/route/v1/driving/' + coords +
    '?overview=full&geometries=geojson&steps=false&annotations=false&alternatives=false&generate_hints=false';

  const hasBearings = Array.isArray(bearings) && bearings.some(b => b !== null && b !== undefined);
  let url = base;
  if (hasBearings){
    url += '&bearings=' + bearings.map(b => (b === null || b === undefined) ? '' : (b + ',90')).join(';');
  }

  try {
    return await request(url);
  } catch (e){
    // Если OSRM вдруг отверг bearings — повторяем без них, чтобы расчёт не падал
    if (hasBearings){
      console.warn('OSRM отверг bearings, повтор без них:', e.message);
      return await request(base);
    }
    throw e;
  }
}

async function request(url){
  const res = await fetch(url);
  if (!res.ok) throw new Error('Сервис маршрутов: HTTP ' + res.status);
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