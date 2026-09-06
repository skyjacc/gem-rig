// Offline demonstration only. Prices, source ages and coverage are fictional.
export const candidates = [
  { id: 'diffusal-lance', name: 'Diffusal Lance', hero: 'Phantom Lancer', market: 'Steam', gem: 'Serene Honor', price: 480, exitPrice: 890, fee: 15, extraction: 120, ageMinutes: 3, status: 'fresh', evidence: 'steam', description: 'Симуляция: вымышленные цены и пример подтверждения сокета Steam. Serene Honor не гарантирован; нужна ручная проверка.' },
  { id: 'fireborn-odachi', name: 'Fireborn Odachi', hero: 'Juggernaut', market: 'Market', gem: 'Нет подтверждённого kinetic', price: 310, exitPrice: 780, fee: 10, extraction: 120, ageMinutes: 5, status: 'fresh', evidence: 'text-only', description: 'Симуляция: kinetic упомянут только в тексте, фактический камень не подтверждён. Вымышленные цены; не торговый сигнал.' },
  { id: 'blood-shard', name: 'Blood Shard', hero: 'Wraith King', market: 'Market', gem: 'Wraith Spin', price: 690, exitPrice: 1300, fee: 10, extraction: 120, ageMinutes: 185, status: 'stale', evidence: 'market', description: 'Симуляция: устаревший пример сокета Wraith Spin. Цены вымышлены, наличие и прибыль не гарантированы.' },
  { id: 'twin-deaths', name: 'Scythe of Twin Deaths', hero: "Nature's Prophet", market: 'Steam', gem: "Twin Deaths' Haunting", price: 930, exitPrice: null, fee: 15, extraction: null, ageMinutes: 0, status: 'unknown', evidence: 'steam', description: 'Симуляция: цена выхода и стоимость извлечения неизвестны. Twin Deaths’ Haunting требует проверки; цена покупки вымышлена.' },
  { id: 'crown-of-gore', name: 'Genuine Crown of Gore', hero: 'Axe', market: 'Steam', gem: 'Crown of Hells!', price: 1450, exitPrice: 1690, fee: 15, extraction: 120, ageMinutes: 9, status: 'fresh', evidence: 'steam', description: 'Симуляция: Crown of Hells! — пример убыточного расчёта после комиссии. Все цены вымышлены, наличие не гарантировано.' },
  { id: 'eye-of-omoz', name: 'Eye of Omoz', hero: 'Doom', market: 'Market', gem: "Dominator's Stance", price: 760, exitPrice: 1250, fee: 10, extraction: 120, ageMinutes: 7, status: 'fresh', evidence: 'market', description: 'Симуляция: пример структурированного подтверждения Dominator’s Stance. Цены вымышлены; перед сделкой обязательна проверка.' },
];

export const sourceFixtures = [
  { id: 'steam-sockets', name: 'Steam · сокеты', role: 'Подтверждение камня', status: 'ok', ageMinutes: 3, coverage: '3 демонстрационные записи', detail: 'Офлайн-фикстура: пример структурированных сокетов, без запросов к Steam.' },
  { id: 'market-listings', name: 'Market · лоты', role: 'Цена покупки', status: 'ok', ageMinutes: 7, coverage: '3 демонстрационных лота', detail: 'Офлайн-фикстура: вымышленные предложения, не действующий рынок.' },
  { id: 'exit-quotes', name: 'Оценки выхода', role: 'Цена перепродажи', status: 'stale', ageMinutes: 185, coverage: '5 из 6 примеров', detail: 'Симуляция устаревших оценок. Выход не гарантирован.' },
  { id: 'kinetic-catalog', name: 'Каталог kinetic', role: 'Названия и герои', status: 'ok', ageMinutes: 20, coverage: '5 примеров камней', detail: 'Локальный демонстрационный справочник, не подтверждение наличия в лоте.' },
  { id: 'text-matches', name: 'Текстовые совпадения', role: 'Неподтверждённые упоминания', status: 'stale', ageMinutes: 90, coverage: '1 текстовое совпадение', detail: 'Текст не доказывает наличие kinetic. Только демонстрация предупреждения.' },
  { id: 'extraction-cost', name: 'Стоимость извлечения', role: 'Расходы', status: 'error', ageMinutes: 240, coverage: '1 пробел в данных', detail: 'Смоделированная ошибка источника. Используйте явно заданную стоимость сценария; API не подключён.' },
];

const isMoney = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100));
// Round RUB to integer kopecks before arithmetic, including the fee deduction.
const minor = (value) => Math.round((value + Number.EPSILON * Math.max(1, Math.abs(value))) * 100);

export function evaluateCandidate(item, { feePercent, extractionCost }) {
  const reasons = [];
  if (item.status === 'stale') reasons.push('Данные устарели: обновите подтверждение.');
  else if (item.status !== 'fresh') reasons.push('Свежесть данных неизвестна.');
  if (item.evidence === 'text-only') reasons.push('Упоминание в тексте не подтверждает наличие kinetic.');
  else if (!['steam', 'market'].includes(item.evidence)) reasons.push('Нет структурированного подтверждения камня.');
  if (item.exitPrice == null) reasons.push('Цена выхода отсутствует.');
  else if (!isMoney(item.exitPrice)) reasons.push('Цена выхода некорректна.');
  if (!isMoney(item.price)) reasons.push('Цена покупки некорректна.');
  if (typeof feePercent !== 'number' || !Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) reasons.push('Комиссия должна быть числом от 0 до 100%.');
  if (!isMoney(extractionCost)) reasons.push('Задайте неотрицательную стоимость извлечения.');
  if (reasons.length) return { net: null, roi: null, eligible: false, label: 'Нужна проверка', reasons };

  const purchase = minor(item.price);
  const extraction = minor(extractionCost);
  const proceeds = Math.round(minor(item.exitPrice) * (1 - feePercent / 100) + Number.EPSILON * minor(item.exitPrice));
  const invested = purchase + extraction;
  const profit = proceeds - invested;
  if (![purchase, extraction, proceeds, invested, profit].every(Number.isSafeInteger)) {
    return { net: null, roi: null, eligible: false, label: 'Нужна проверка', reasons: ['Сумма выходит за пределы безопасного расчёта.'] };
  }
  const net = profit / 100;
  // ROI is a percentage of purchase + extraction. A zero basis has no ROI.
  const roi = invested > 0 ? Math.round((profit / invested) * 10000) / 100 : null;
  const eligible = profit > 0 && invested > 0;
  if (invested === 0) reasons.push('Нулевая база затрат: ROI не определён.');
  if (profit <= 0) reasons.push('После комиссии и извлечения положительной прибыли нет.');
  reasons.push('Только симуляция на вымышленных ценах; перед сделкой проверьте лот.');
  return { net, roi, eligible, label: eligible ? 'Потенциал · симуляция' : 'Нет сигнала', reasons };
}

export function filterCandidates(items, { query = '', market = 'all', state = 'all' } = {}) {
  const needle = query.trim().toLocaleLowerCase('ru-RU');
  return items.filter((item) => {
    const searchable = [item.name, item.hero, item.gem, item.market, item.description].join(' ').toLocaleLowerCase('ru-RU');
    const confirmed = item.status === 'fresh' && ['steam', 'market'].includes(item.evidence) && isMoney(item.exitPrice);
    return (!needle || searchable.includes(needle)) && (market === 'all' || item.market === market)
      && (state === 'all' || (state === 'fresh' && item.status === 'fresh') || (state === 'attention' && !confirmed));
  });
}

const REDACTED = '[REDACTED]';
const sensitiveKey = /key|token|authorization|cookie|password|secret/i;
const namedSecret = String.raw`[\w.-]*(?:key|token|authorization|cookie|password|secret)[\w.-]*`;
const inlineSecret = new RegExp(String.raw`((?:["']?${namedSecret}["']?)\s*(?:=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;#}\]\r\n]+)`, 'gi');
const secretHeader = new RegExp(String.raw`(^|[\r\n])([\t ]*${namedSecret}\s*:[\t ]*)[^\r\n]*`, 'gi');

function sanitizeString(value) {
  // Decode nested URL escapes before matching (including encoded parameter names).
  for (let count = 0; count < 8; count += 1) {
    const decoded = value.replace(/(?:%[0-9a-f]{2})+/gi, (part) => {
      try { return decodeURIComponent(part); } catch { return part.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))); }
    });
    if (decoded === value) break;
    value = decoded;
  }
  return value
    .replace(secretHeader, (_, prefix, name) => `${prefix}${name}${REDACTED}`)
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, `$1 ${REDACTED}`)
    .replace(inlineSecret, (_, prefix) => `${prefix}${REDACTED}`)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    // Demo sentinels are never exported, even outside a recognized secret field.
    .replace(/\b[^\s"'&=,:;{}\[\]]*SECRET[^\s"'&=,:;{}\[\]]*/gi, REDACTED);
}

export function redact(value) {
  const active = new WeakSet();
  function visit(current) {
    if (typeof current === 'string') return sanitizeString(current);
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number') return Number.isFinite(current) ? current : null;
    if (typeof current === 'bigint') return current.toString();
    if (typeof current !== 'object') return null;
    if (active.has(current)) return '[Circular]';
    active.add(current);
    let result;
    if (Array.isArray(current)) result = current.map(visit);
    else {
      result = {};
      for (const key of Object.keys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        const safeKey = sanitizeString(key);
        // Do not invoke accessors or user-defined toJSON methods during export.
        const next = sensitiveKey.test(key) ? REDACTED : descriptor && 'value' in descriptor ? visit(descriptor.value) : REDACTED;
        Object.defineProperty(result, safeKey, { value: next, enumerable: true, configurable: true, writable: true });
      }
    }
    active.delete(current);
    return result;
  }
  return visit(value);
}

export function exportReport(events, context) {
  return JSON.stringify({ schemaVersion: 1, mode: 'simulation', context: redact(context), events: redact(events) }, null, 2);
}
