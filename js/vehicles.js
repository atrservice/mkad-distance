// Типы техники. Список автоматически сортируется по алфавиту (А–Я).
//
// Характеристики (specs) добавим, когда вы пришлёте наборы.
// Формат одной характеристики:
//   { id: 'уникальный', name: 'Название', type: 'select', options: ['вариант 1', 'вариант 2'] }
//   { id: 'уникальный', name: 'Название', type: 'number', unit: 'м' }
//   { id: 'уникальный', name: 'Название', type: 'text' }

export const VEHICLES = [
  { id: 'avtovyshka',   name: 'Автовышка',              specs: [] },
  { id: 'avtokran',     name: 'Автокран',               specs: [] },
  { id: 'prikrytie',    name: 'Автомобиль прикрытия',   specs: [] },
  { id: 'manipulyator', name: 'Кран-манипулятор',       specs: [] }
].sort((a, b) => a.name.localeCompare(b.name, 'ru'));

/* Пример (как это будет выглядеть, когда вы дадите характеристики):

{
  id: 'avtovyshka',
  name: 'Автовышка',
  specs: [
    { id: 'height', name: 'Высота подъёма', type: 'select', options: ['12 м', '15 м', '18 м', '22 м', '28 м', '30 м', '45 м'] },
    { id: 'boom',   name: 'Тип стрелы',     type: 'select', options: ['Телескопическая', 'Коленчатая'] },
    { id: 'load',   name: 'Грузоподъёмность люльки', type: 'number', unit: 'кг' }
  ]
}
*/