/** Справочники и симулятор внешних систем для демо-режима (повторяют backend/app/seed.py и mocks/app.py). */
import fixturesRaw from "./fixtures.json";
import { PRIORITY_OKVED } from "./engine";

export const KEY_RATE = 14.0;
export const AUTO_DECISION_LIMIT = 10_000_000;
export const COMMITTEE_LIMIT = 15_000_000;
export const OFFER_TTL_DAYS = 14;
export const STEP_DELAY_MS = 1500;

export const PRODUCTS = [
  { code: "EXPRESS", name: "Экспресс-кредит", tagline: "До 10 млн ₽ без залога, решение онлайн за минуты",
    description: "Беззалоговый кредит на любые цели бизнеса. Данные о компании банк получает сам из ЕГРЮЛ и ФНС — документы не нужны. Решение принимается автоматически.",
    min_amount: 300_000, max_amount: 10_000_000, min_term: 3, max_term: 36, margin: 6.0, rate_cap: null, collateral_required: false, guarantee_required: false, requires_account: false,
    purposes: ["WORKING_CAPITAL", "CASH_GAP", "EQUIPMENT", "EXPANSION", "TENDER"], eligible_okved_prefixes: [] as string[], required_documents: [] as string[], decision_time: "≈ 5 минут", sort_order: 1 },
  { code: "GOV_1764", name: "Льготный кредит МСП", tagline: "Ставка ниже рыночной для приоритетных отраслей",
    description: "Кредит по программе государственной поддержки субъектов МСП (упрощённая модель): ставка — ключевая ставка ЦБ + 2,75 п.п. Доступен для производства, сельского хозяйства, IT, логистики, туризма, образования и здравоохранения.",
    min_amount: 500_000, max_amount: 30_000_000, min_term: 6, max_term: 36, margin: 2.75, rate_cap: null, collateral_required: false, guarantee_required: false, requires_account: false,
    purposes: ["EQUIPMENT", "WORKING_CAPITAL", "EXPANSION"], eligible_okved_prefixes: PRIORITY_OKVED, required_documents: [], decision_time: "≈ 5 минут", sort_order: 2 },
  { code: "WORKING_CAPITAL", name: "Оборотный кредит", tagline: "До 50 млн ₽ на закупки, сезонность и госконтракты",
    description: "Кредит на пополнение оборотных средств под поручительство собственника бизнеса. Для сумм больше 10 млн ₽ нужна бухгалтерская отчётность.",
    min_amount: 1_000_000, max_amount: 50_000_000, min_term: 3, max_term: 24, margin: 5.0, rate_cap: null, collateral_required: false, guarantee_required: true, requires_account: false,
    purposes: ["WORKING_CAPITAL", "TENDER", "CASH_GAP", "REFINANCE"], eligible_okved_prefixes: [], required_documents: [], decision_time: "от 1 часа", sort_order: 3 },
  { code: "INVEST", name: "Инвестиционный кредит", tagline: "До 150 млн ₽ на оборудование и недвижимость под залог",
    description: "Долгосрочное финансирование покупки оборудования, транспорта или недвижимости. Приобретаемое имущество может стать залогом.",
    min_amount: 3_000_000, max_amount: 150_000_000, min_term: 12, max_term: 84, margin: 4.0, rate_cap: null, collateral_required: true, guarantee_required: false, requires_account: false,
    purposes: ["EQUIPMENT", "REAL_ESTATE", "EXPANSION"], eligible_okved_prefixes: [], required_documents: ["COLLATERAL_DOCS"], decision_time: "1–2 рабочих дня", sort_order: 4 },
  { code: "OVERDRAFT", name: "Овердрафт", tagline: "Покрытие кассовых разрывов в пределах оборотов по счёту",
    description: "Лимит до 40% среднемесячных поступлений на расчётный счёт в банке. В прототипе моделируется как краткосрочный кредит с аннуитетным погашением.",
    min_amount: 100_000, max_amount: 20_000_000, min_term: 1, max_term: 12, margin: 7.0, rate_cap: null, collateral_required: false, guarantee_required: false, requires_account: true,
    purposes: ["CASH_GAP"], eligible_okved_prefixes: [], required_documents: [], decision_time: "≈ 5 минут", sort_order: 5 },
];

export const DEMO_ACCOUNTS = [
  { email: "bakery@demo.ru", password: "Demo123!", role: "CLIENT", title: "ООО «Хлебный Дом»", hint: "пекарня, сильный профиль → автоодобрение" },
  { email: "smirnov@demo.ru", password: "Demo123!", role: "CLIENT", title: "ИП Смирнов А. В.", hint: "грузоперевозки → встречное предложение" },
  { email: "stroy@demo.ru", password: "Demo123!", role: "CLIENT", title: "ООО «СтройМонтаж Плюс»", hint: "просрочки, отметки ФНС → ручное рассмотрение" },
  { email: "romashka@demo.ru", password: "Demo123!", role: "CLIENT", title: "ООО «Ромашка Трейд»", hint: "стоп-факторы → отказ с объяснением" },
  { email: "analyst@bank.ru", password: "Analyst123!", role: "ANALYST", title: "Кредитный аналитик", hint: "очередь ручного рассмотрения" },
  { email: "risk@bank.ru", password: "Risk123!", role: "RISK_MANAGER", title: "Риск-менеджер", hint: "согласование крупных сумм" },
  { email: "admin@bank.ru", password: "Admin123!", role: "ADMIN", title: "Администратор", hint: "управление лентой новостей" },
];

export const DEMO_CLIENTS = [
  ["bakery@demo.ru", "Мария Иванова", "Генеральный директор", "7704123450"],
  ["smirnov@demo.ru", "Алексей Смирнов", "Индивидуальный предприниматель", "165512345632"],
  ["stroy@demo.ru", "Игорь Кузнецов", "Генеральный директор", "5406123450"],
  ["romashka@demo.ru", "Павел Сидоров", "Генеральный директор", "7810123451"],
];
export const EMPLOYEES = [
  ["analyst@bank.ru", "Ксения Андеррайтерова", "Кредитный аналитик МСБ", "ANALYST"],
  ["risk@bank.ru", "Роман Рисков", "Риск-менеджер", "RISK_MANAGER"],
  ["admin@bank.ru", "Анна Админова", "Администратор продукта", "ADMIN"],
];
export const HISTORY: [string, string, number, number, string, number, string[], string | null][] = [
  ["6671123450", "EXPRESS", 2_000_000, 18, "EQUIPMENT", 0, [], "DISBURSE"],
  ["7715123451", "WORKING_CAPITAL", 12_000_000, 12, "WORKING_CAPITAL", 0, ["FIN_STATEMENTS"], null],
  ["165612345629", "EXPRESS", 3_000_000, 24, "EXPANSION", 0, [], null],
  ["2310123454", "GOV_1764", 8_000_000, 36, "EQUIPMENT", 0, [], "ACCEPT"],
  ["7814123452", "EXPRESS", 4_000_000, 24, "WORKING_CAPITAL", 0, [], null],
  ["5408123456", "INVEST", 25_000_000, 60, "EQUIPMENT", 40_000_000, ["COLLATERAL_DOCS", "FIN_STATEMENTS"], null],
];

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
export const NEWS = () => [
  { title: "Банк России сохранил ключевую ставку на уровне 14%", category: "MARKET", priority: 25, published_at: daysAgo(2),
    summary: "Совет директоров ЦБ на заседании 11 сентября оставил ставку без изменений. Следующее решение — 23 октября.",
    body: "Ключевая ставка влияет на стоимость новых кредитов с плавающей и рыночной ставкой. Ставки по уже выданным кредитам с фиксированной ставкой не меняются.", source: "Банк России (по открытым данным)", tags: {} },
  { title: "Как банк считает лимит кредита: DSCR простыми словами", category: "EDUCATION", priority: 15, published_at: daysAgo(6),
    summary: "Почему банк может предложить меньшую сумму, чем вы просили, и как увеличить доступный лимит.",
    body: "Банк сравнивает ежемесячный денежный поток бизнеса с платежами по всем кредитам. Если платежи превышают поток, делённый на 1,3, сумма уменьшается или срок увеличивается.",
    tags: { products: ["EXPRESS", "WORKING_CAPITAL"] }, cta_label: "Рассчитать платёж", cta_link: "/products" },
  { title: "Льготные кредиты для производителей: ставка ниже рыночной", category: "SUPPORT", priority: 30, published_at: daysAgo(3),
    summary: "Компании обрабатывающих отраслей могут получить кредит по программе поддержки МСП со ставкой «ключевая + 2,75 п.п.».",
    body: "Программа поддержки МСП позволяет производственным компаниям получить финансирование на оборудование и оборотные средства по сниженной ставке.",
    tags: { okved: Array.from({ length: 24 }, (_, i) => String(10 + i)) }, cta_label: "Подобрать кредит", cta_link: "/products?product=GOV_1764" },
  { title: "Агробизнесу: сезонное финансирование посевной и уборочной", category: "SUPPORT", priority: 30, published_at: daysAgo(5),
    summary: "Сельхозпроизводители входят в приоритетные отрасли льготной программы — до 30 млн ₽ на 3 года.",
    body: "Планируйте финансирование сезонных работ заранее: решение по льготному кредиту принимается за минуты.", tags: { okved: ["01", "02", "03"] }, cta_label: "Льготный кредит", cta_link: "/products?product=GOV_1764" },
  { title: "Пекарням и кондитерским: как пережить рост цен на муку", category: "INDUSTRY", priority: 20, published_at: daysAgo(1),
    summary: "Закупка сырья впрок под оборотный кредит может оказаться выгоднее, чем рост цен в сезон.",
    body: "Демо-материал: сравните стоимость кредита с ожидаемым ростом цен на сырьё и зафиксируйте закупку.", tags: { okved: ["10.7", "10.8", "56"] } },
  { title: "Грузоперевозчикам: как планировать оборотные средства в межсезонье", category: "INDUSTRY", priority: 20, published_at: daysAgo(2),
    summary: "Топливо, ремонт и лизинговые платежи — как не допустить кассового разрыва зимой.",
    body: "Демо-материал: оцените сезонность выручки по выписке и заранее согласуйте лимит.", tags: { okved: ["49", "52"] } },
  { title: "Строительным компаниям: что банк проверяет при крупном кредите", category: "INDUSTRY", priority: 20, published_at: daysAgo(4),
    summary: "Отчётность, загрузка по контрактам, просрочки и залог: как подготовиться к экспертизе.",
    body: "Демо-материал: подготовьте бухгалтерскую отчётность и перечень действующих контрактов заранее.", tags: { okved: ["41", "42", "43"] } },
  { title: "Розничной торговле: управление запасами перед новогодним сезоном", category: "INDUSTRY", priority: 18, published_at: daysAgo(3),
    summary: "Как рассчитать потребность в оборотных средствах на закупку к пиковому сезону.",
    body: "Демо-материал: используйте данные продаж прошлого года, чтобы определить объём закупки.", tags: { okved: ["47"] } },
  { title: "ИП: календарь налоговых платежей на IV квартал", category: "TAX", priority: 18, published_at: daysAgo(7),
    summary: "Сроки уплаты авансовых платежей по УСН и страховых взносов за себя.", body: "Демо-материал: проверьте сроки в личном кабинете налогоплательщика.", tags: { legal_forms: ["IP"] } },
  { title: "ООО: отчётность за 9 месяцев — сроки и частые ошибки", category: "TAX", priority: 15, published_at: daysAgo(8),
    summary: "Что и когда сдать по итогам 9 месяцев, чтобы не получить блокировку счёта.", body: "Демо-материал.", tags: { legal_forms: ["OOO"] } },
  { title: "Заявка у специалиста: как ускорить рассмотрение", category: "EDUCATION", priority: 20, published_at: daysAgo(1),
    summary: "Чаще всего решение ускоряет выписка по счёту и быстрый ответ на запрос банка.",
    body: "Если банк запросил информацию, ответ прямо в заявке возвращает её в работу автоматически.", tags: { statuses: ["MANUAL_REVIEW", "COMMITTEE_REVIEW", "INFO_REQUESTED"] } },
  { title: "Кредит одобрен: что проверить в договоре перед подписанием", category: "EDUCATION", priority: 20, published_at: daysAgo(1),
    summary: "Ставка, полная стоимость, график, досрочное погашение и обеспечение — короткий чек-лист.",
    body: "Подписывайте договор только кодом из уведомлений личного кабинета. Сотрудники банка код не спрашивают.", tags: { statuses: ["APPROVED", "COUNTER_OFFER", "OFFER_ACCEPTED", "SIGNING"] } },
  { title: "Получили кредит? Подключите торговый эквайринг со скидкой", category: "PRODUCT", priority: 15, published_at: daysAgo(2),
    summary: "Персональное предложение для заёмщиков: льготная комиссия первые 3 месяца.", body: "Демо-материал: пример next-best-offer после выдачи кредита.",
    tags: { statuses: ["DISBURSED"] }, cta_label: "Подробнее", cta_link: "/" },
  { title: "Отказали в кредите? 5 шагов к улучшению кредитного профиля", category: "EDUCATION", priority: 20, published_at: daysAgo(2),
    summary: "Налоговая дисциплина, отсутствие просрочек, подтверждённые обороты — что влияет на решение сильнее всего.",
    body: "В карточке заявки показаны факторы, которые повлияли на решение, и рекомендации.", tags: { statuses: ["REJECTED"] } },
  { title: "Москва: субсидия на модернизацию оборудования для МСП", category: "SUPPORT", priority: 20, published_at: daysAgo(6),
    summary: "Демо-материал: региональная мера поддержки компенсирует часть затрат на оборудование.", body: "Демо-материал.", tags: { regions: ["г. Москва"] } },
  { title: "Татарстан: региональный фонд поручительств для МСП", category: "SUPPORT", priority: 20, published_at: daysAgo(5),
    summary: "Демо-материал: поручительство фонда может заменить часть залога.", body: "Демо-материал.", tags: { regions: ["Республика Татарстан"] } },
  { title: "Новосибирская область: гарантийный фонд снижает требования к залогу", category: "SUPPORT", priority: 20, published_at: daysAgo(4),
    summary: "Демо-материал: поручительство до 50% суммы кредита.", body: "Демо-материал.", tags: { regions: ["Новосибирская область"] } },
  { title: "Микробизнесу: бизнес-карта с кешбэком на топливо", category: "PRODUCT", priority: 12, published_at: daysAgo(9),
    summary: "Демо-материал: предложение для небольших транспортных компаний.", body: "Демо-материал.", tags: { segments: ["micro"], okved: ["49"] } },
];

// ---------------------------------------------------------------- внешние системы (симулятор)

const FIXTURES = Object.fromEntries(Object.entries(fixturesRaw as Record<string, any>).filter(([k]) => !k.startsWith("_")));

export function isValidInn(inn: string): boolean {
  const chk = (d: string, c: number[]) => (c.reduce((a, k, i) => a + k * Number(d[i]), 0) % 11) % 10;
  if (!/^\d+$/.test(inn)) return false;
  if (inn.length === 10) return chk(inn, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[9]);
  if (inn.length === 12)
    return chk(inn, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[10]) && chk(inn, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[11]);
  return false;
}

function rng(seedStr: string) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OKVEDS = [["10.71", "Производство хлеба и мучных кондитерских изделий"], ["25.62", "Обработка металлических изделий"], ["47.11", "Торговля розничная в неспециализированных магазинах"],
  ["49.41", "Деятельность автомобильного грузового транспорта"], ["56.10", "Деятельность ресторанов и услуги по доставке продуктов питания"], ["62.01", "Разработка компьютерного программного обеспечения"],
  ["41.20", "Строительство жилых и нежилых зданий"], ["68.20", "Аренда и управление недвижимым имуществом"], ["86.23", "Стоматологическая практика"], ["01.13", "Выращивание овощей"],
  ["96.02", "Услуги парикмахерских и салонов красоты"]];
const REGIONS = ["г. Москва", "г. Санкт-Петербург", "Республика Татарстан", "Новосибирская область", "Свердловская область", "Краснодарский край", "Нижегородская область", "Самарская область"];
const SURNAMES = ["Иванов", "Смирнов", "Кузнецов", "Попов", "Васильев", "Петров", "Соколов", "Михайлов", "Новиков", "Фёдоров"];
const NAMES = ["Алексей", "Дмитрий", "Сергей", "Андрей", "Ольга", "Наталья", "Елена", "Игорь", "Марина", "Павел"];

function generatedProfile(inn: string) {
  const r = rng(inn);
  const pick = <T,>(arr: T[]) => arr[Math.floor(r() * arr.length)];
  const ip = inn.length === 12;
  const okved = pick(OKVEDS);
  const reg = new Date(Date.now() - (60 + Math.floor(r() * 15 * 365)) * 86400_000).toISOString().slice(0, 10);
  const revenue = Math.round((3 + r() * 297) * 100) * 10_000;
  const margin = -0.02 + r() * 0.27;
  const person = `${pick(SURNAMES)} ${pick(NAMES)}`;
  const name = ip ? `ИП ${person}` : `ООО «Компания ${inn.slice(-4)}»`;
  const overdue = pick([0, 0, 0, 0, 15, 40, 120]);
  const loans = Array.from({ length: Math.floor(r() * 3) }, () => ({ lender: "Банк-партнёр", type: "Кредит", amount: Math.round(revenue * 0.1), balance: Math.round(revenue * 0.05), monthly_payment: Math.round(revenue * 0.004), overdue_days: 0 }));
  const employees = 1 + Math.floor(r() * 120);
  const isClient = r() < 0.4;
  const af = r();
  return {
    egrul: { ogrn: (ip ? "3" : "1") + inn.padEnd(14, "0").slice(0, ip ? 14 : 12), full_name: ip ? `Индивидуальный предприниматель ${person}` : name.toUpperCase(), short_name: name,
      legal_form: ip ? "IP" : "OOO", status: Number(inn.slice(-3)) % 25 === 0 ? "LIQUIDATING" : "ACTIVE", registration_date: reg, region: pick(REGIONS), address: "адрес синтетический",
      okved_main: { code: okved[0], name: okved[1] }, okved_additional: [], director: { name: person, position: ip ? "Индивидуальный предприниматель" : "Генеральный директор" },
      founders: ip ? [] : [{ name: person, share: 100 }], msp_category: employees <= 15 ? "micro" : employees <= 100 ? "small" : "medium", employees },
    fns: { year: new Date().getFullYear() - 1, revenue_last_year: revenue, expenses_last_year: Math.round(revenue * (1 - margin)), taxes_paid: Math.round(revenue * 0.04),
      tax_arrears: pick([0, 0, 0, 0, 0, 80_000, 900_000]), avg_employees: employees, tax_regime: pick(["УСН «доходы»", "УСН «доходы минус расходы»", "ОСН"]),
      flags: { mass_address: r() < 0.08, unreliable_info: r() < 0.05, disqualified_director: r() < 0.03 } },
    bki: { score: 450 + Math.floor(r() * 400), max_overdue_days_12m: overdue, current_overdue_days: overdue < 100 ? 0 : 35, inquiries_30d: Math.floor(r() * 8), closed_loans: Math.floor(r() * 7), active_loans: loans },
    accounts: { is_client: isClient, account_months: isClient ? 3 + Math.floor(r() * 58) : 0, avg_monthly_inflow: isClient ? Math.round((revenue / 12) * (0.6 + r() * 0.35)) : 0,
      avg_monthly_outflow: isClient ? Math.round((revenue / 12) * 0.7) : 0, avg_balance: isClient ? Math.round(revenue / 50) : 0, account_number: isClient ? "40702810" + inn.slice(-10).padStart(12, "0") : null },
    antifraud: { risk_level: af < 0.9 ? "LOW" : af < 0.98 ? "MEDIUM" : "HIGH", reasons: [] },
  };
}

export function profile(inn: string): any {
  return FIXTURES[inn] || generatedProfile(inn);
}

export const external = {
  egrul: (inn: string) => ({ inn, found: true, ...profile(inn).egrul }),
  fns: (inn: string) => ({ inn, found: true, ...profile(inn).fns }),
  bki: (inn: string) => ({ inn, found: true, report_id: Math.random().toString(16).slice(2), generated_at: new Date().toISOString(), ...profile(inn).bki }),
  antifraud: (inn: string) => ({ inn, found: true, ...profile(inn).antifraud }),
  accounts: (inn: string) => ({ inn, found: true, ...profile(inn).accounts }),
  disburse: (inn: string) => ({
    loan_id: "LN-" + Math.random().toString(16).slice(2, 12).toUpperCase(),
    account: profile(inn).accounts.account_number || "40702810" + inn.slice(-10).padStart(12, "0"),
    disbursed_at: new Date().toISOString(), status: "DISBURSED",
  }),
};

// ---------------------------------------------------------------- выписка CSV

export function parseBankStatement(text: string) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const sample = text.slice(0, 2000);
  const delim = (sample.match(/;/g) || []).length >= (sample.match(/,/g) || []).length ? ";" : ",";
  const inflow: Record<string, number> = {};
  const outflow: Record<string, number> = {};
  let rows = 0;
  for (const line of lines) {
    const rec = line.split(delim);
    if (rec.length < 2) continue;
    let d: Date | null = null;
    const ds = rec[0].trim();
    let m = ds.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) d = new Date(+m[1], +m[2] - 1, +m[3]);
    m = ds.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) d = new Date(+m[3], +m[2] - 1, +m[1]);
    const a = Number(rec[1].replace(/[\s ]/g, "").replace(",", "."));
    if (!d || isNaN(a) || rec[1].trim() === "") continue;
    rows++;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (a >= 0) inflow[key] = (inflow[key] || 0) + a;
    else outflow[key] = (outflow[key] || 0) - a;
  }
  const months = [...new Set([...Object.keys(inflow), ...Object.keys(outflow)])].sort();
  if (!rows || !months.length) return { ok: false, error: "Не удалось распознать операции. Ожидается CSV: дата;сумма;назначение" };
  const sum = (o: Record<string, number>) => Object.values(o).reduce((x, y) => x + y, 0);
  const avgIn = sum(inflow) / months.length;
  return {
    ok: true, operations: rows, months: months.length, period: `${months[0]} — ${months[months.length - 1]}`,
    avg_monthly_inflow: Math.round(avgIn * 100) / 100, avg_monthly_outflow: Math.round((sum(outflow) / months.length) * 100) / 100,
    annualized_inflow: Math.round(avgIn * 12 * 100) / 100,
    by_month: months.map((mm) => ({ month: mm, inflow: inflow[mm] || 0, outflow: outflow[mm] || 0 })),
  };
}
