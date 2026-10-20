export const rub = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : `${v.toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: digits })} ₽`;

export const mln = (v: number) => (v >= 1e6 ? `${(v / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} млн ₽` : rub(v));

export const dt = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export const d = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("ru-RU") : "—");

export const months = (n: number) => {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? "месяц" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "месяца" : "месяцев";
  return `${n} ${w}`;
};

export const PURPOSES: Record<string, string> = {
  EQUIPMENT: "Оборудование, транспорт",
  WORKING_CAPITAL: "Оборотные средства, закупки",
  CASH_GAP: "Кассовый разрыв: зарплата, налоги",
  EXPANSION: "Развитие: новая точка, направление",
  REAL_ESTATE: "Помещение: покупка, ремонт",
  REFINANCE: "Рефинансирование",
  TENDER: "Исполнение госконтракта",
};

export const DOC_LABELS: Record<string, string> = {
  FIN_STATEMENTS: "Бухгалтерская отчётность",
  BANK_STATEMENT: "Выписка по счёту (CSV)",
  COLLATERAL_DOCS: "Документы по залогу",
  OTHER: "Иной документ",
  CONTRACT: "Кредитный договор",
};

export const STATUS_TONE: Record<string, string> = {
  DRAFT: "neutral", SUBMITTED: "info", VALIDATION: "info", ENRICHMENT: "info", SCORING: "info",
  INFO_REQUESTED: "warn", MANUAL_REVIEW: "info", COMMITTEE_REVIEW: "info",
  APPROVED: "ok", COUNTER_OFFER: "ok", OFFER_ACCEPTED: "ok", SIGNING: "warn", SIGNED: "ok", DISBURSED: "ok",
  REJECTED: "bad", CANCELLED: "neutral",
};

export const IN_PROGRESS = new Set(["SUBMITTED", "VALIDATION", "ENRICHMENT", "SCORING", "OFFER_ACCEPTED", "SIGNED"]);
