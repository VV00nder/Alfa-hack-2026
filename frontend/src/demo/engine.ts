/**
 * Порт модели решения backend/app/scoring/engine.py (SME-SCORECARD-1.3) для демо-режима в браузере.
 * Логика и параметры совпадают с серверной версией; источник истины — Python-модуль.
 */

export const MODEL_VERSION = "SME-SCORECARD-1.3";
const BASE_SCORE = 520;
export const DSCR_MIN = 1.3;
const UNSECURED_REVENUE_CAP = 0.5;
const OVERDRAFT_TURNOVER_CAP = 0.4;
const GRADES: [number, string][] = [[600, "A"], [550, "B"], [500, "C"], [450, "D"], [-10000, "E"]];
const GRADE_PREMIUM: Record<string, number> = { A: 0, B: 1.5, C: 3, D: 5, E: 8 };
const CLIENT_DISCOUNT = 0.5;

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
export const LOW_RISK_OKVED = ["01", "02", "03", "62", "63", "72", "85", "86", ...range(10, 33)];
const HIGH_RISK_OKVED = ["41", "42", "43", "64", "66", "68", "92"];
export const PRIORITY_OKVED = [...LOW_RISK_OKVED, "49", "52", "55"];

export interface Features {
  business_age_months: number;
  revenue_annual: number;
  expenses_annual: number;
  existing_monthly_payments: number;
  okved: string;
  company_status: string;
  bki_score: number | null;
  max_overdue_days_12m: number;
  current_overdue_days: number;
  inquiries_30d: number;
  tax_arrears: number;
  is_bank_client: boolean;
  account_months: number;
  avg_turnover_in: number;
  disqualified_director: boolean;
  mass_address: boolean;
  unreliable_info: boolean;
  antifraud_level: string;
  collateral_value: number;
  has_guarantee: boolean;
  revenue_verified: boolean;
  sources_unavailable: string[];
}

export interface ProductTerms {
  code: string;
  name: string;
  min_amount: number;
  max_amount: number;
  min_term: number;
  max_term: number;
  margin: number;
  rate_cap?: number | null;
  collateral_required?: boolean;
  requires_account?: boolean;
  eligible_okved_prefixes?: string[];
}

export interface Offer {
  kind: string;
  product_code: string;
  product_name: string;
  amount: number;
  term_months: number;
  rate: number;
  monthly_payment: number;
  total_payment: number;
  overpayment: number;
  note: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
export const fmt = (v: number) => Math.round(v).toLocaleString("ru-RU");
const startsWithAny = (s: string, pref: string[]) => pref.some((p) => s.startsWith(p));

// ---------------------------------------------------------------- finance

export function annuity(principal: number, ratePct: number, months: number): number {
  if (months <= 0) return 0;
  const r = ratePct / 100 / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

export function maxPrincipal(payment: number, ratePct: number, months: number): number {
  if (payment <= 0 || months <= 0) return 0;
  const r = ratePct / 100 / 12;
  if (r === 0) return payment * months;
  return (payment * (1 - Math.pow(1 + r, -months))) / r;
}

export function schedule(principal: number, ratePct: number, months: number, start: Date) {
  const r = ratePct / 100 / 12;
  let pay = annuity(principal, ratePct, months);
  let balance = principal;
  const rows = [];
  for (let i = 1; i <= months; i++) {
    const interest = balance * r;
    let body = pay - interest;
    if (i === months) {
      body = balance;
      pay = body + interest;
    }
    balance -= body;
    const d = new Date(start);
    d.setMonth(d.getMonth() + i);
    rows.push({ n: i, date: d.toISOString().slice(0, 10), payment: r2(pay), principal: r2(body), interest: r2(interest), balance: r2(Math.max(balance, 0)) });
  }
  return rows;
}

const roundDown = (v: number, step = 50_000) => Math.floor(v / step) * step;

// ---------------------------------------------------------------- helpers

export function sectorRisk(okved: string) {
  if (startsWithAny(okved, HIGH_RISK_OKVED)) return "HIGH";
  if (startsWithAny(okved, LOW_RISK_OKVED)) return "LOW";
  return "MEDIUM";
}

export const gradeFor = (score: number) => GRADES.find(([t]) => score >= t)![1];
export const pdFor = (score: number) => Math.round((1 / (1 + Math.exp((score - 470) / 38))) * 10000) / 10000;

export function rateFor(p: ProductTerms, grade: string, isClient: boolean, keyRate: number) {
  let rate = keyRate + p.margin + GRADE_PREMIUM[grade] - (isClient ? CLIENT_DISCOUNT : 0);
  if (p.rate_cap != null) rate = Math.min(rate, p.rate_cap);
  return r2(rate);
}

export const monthlyCashFlow = (f: Features) => (f.revenue_annual - f.expenses_annual) / 12;

export function productEligibility(p: ProductTerms, f: Features) {
  const problems: string[] = [];
  if (p.requires_account && !f.is_bank_client) problems.push("Продукт доступен только клиентам с расчётным счётом в банке");
  if (p.eligible_okved_prefixes?.length && !startsWithAny(f.okved, p.eligible_okved_prefixes))
    problems.push("Вид деятельности (ОКВЭД) не входит в перечень приоритетных отраслей программы");
  if (p.collateral_required && f.collateral_value <= 0) problems.push("Для продукта требуется залог");
  return problems;
}

// ---------------------------------------------------------------- 1. policy

export function policyChecks(f: Features) {
  const stops: { code: string; label: string }[] = [];
  const manual: { code: string; label: string }[] = [];
  if (f.company_status !== "ACTIVE") stops.push({ code: "SF01", label: `Статус компании в ЕГРЮЛ: ${f.company_status}` });
  if (f.disqualified_director) stops.push({ code: "SF02", label: "Руководитель находится в реестре дисквалифицированных лиц" });
  if (f.current_overdue_days > 30 || f.max_overdue_days_12m > 90) stops.push({ code: "SF03", label: "Существенная просроченная задолженность по данным БКИ" });
  if (f.antifraud_level === "HIGH") stops.push({ code: "SF04", label: "Высокий риск мошенничества по данным антифрод-проверки" });
  if (f.business_age_months < 3) stops.push({ code: "SF05", label: "Срок деятельности бизнеса менее 3 месяцев" });
  if (f.tax_arrears > 500_000) stops.push({ code: "SF06", label: "Задолженность по налогам более 500 тыс. ₽" });
  if (monthlyCashFlow(f) <= 0) stops.push({ code: "SF07", label: "Отрицательный денежный поток бизнеса" });
  if (f.mass_address || f.unreliable_info) manual.push({ code: "MT01", label: "Отметки ФНС: адрес массовой регистрации / недостоверные сведения" });
  if (f.antifraud_level === "MEDIUM") manual.push({ code: "MT02", label: "Средний риск по антифрод-проверке" });
  for (const src of f.sources_unavailable) manual.push({ code: "MT03", label: `Источник данных недоступен: ${src}` });
  if (!f.revenue_verified) manual.push({ code: "MT04", label: "Выручка не подтверждена внешними данными" });
  return { stops, manual };
}

// ---------------------------------------------------------------- 2. scorecard

export interface Factor { code: string; label: string; value: string; points: number; hint: string }

export function scorecard(f: Features): [number, Factor[]] {
  const factors: Factor[] = [];
  const add = (code: string, label: string, value: string, points: number, hint = "") => factors.push({ code, label, value, points, hint });

  const m = f.business_age_months;
  add("AGE", "Срок деятельности", `${Math.floor(m / 12)} г. ${m % 12} мес.`, m < 6 ? -60 : m < 12 ? -30 : m < 24 ? 0 : m < 60 ? 25 : 40,
    "Срок работы бизнеса больше 2 лет повышает оценку");

  const margin = f.revenue_annual > 0 ? (f.revenue_annual - f.expenses_annual) / f.revenue_annual : -1;
  add("MARGIN", "Рентабельность", `${(margin * 100).toFixed(1)}%`, margin < 0 ? -60 : margin < 0.05 ? -15 : margin < 0.15 ? 15 : 30,
    "Устойчивая рентабельность выше 15% повышает оценку");

  const cf = monthlyCashFlow(f);
  const load = cf > 0 ? f.existing_monthly_payments / cf : 99;
  add("DEBT_LOAD", "Текущая долговая нагрузка", `${(Math.min(load, 9.99) * 100).toFixed(0)}% денежного потока`,
    f.existing_monthly_payments === 0 ? 20 : load < 0.3 ? 10 : load < 0.6 ? -15 : -50, "Снижение текущих платежей по кредитам освобождает лимит");

  if (f.bki_score == null) add("BKI_SCORE", "Кредитная история", "нет истории", -5, "Положительная кредитная история повышает оценку");
  else {
    const s = f.bki_score;
    add("BKI_SCORE", "Скоринговый балл БКИ", String(s), s < 500 ? -50 : s < 650 ? -10 : s < 750 ? 20 : 40, "Своевременные платежи улучшают балл БКИ");
  }

  const d = f.max_overdue_days_12m;
  add("OVERDUE", "Просрочки за 12 мес.", d === 0 ? "нет" : `до ${d} дн.`, d === 0 ? 20 : d <= 30 ? -20 : d <= 60 ? -60 : -100,
    "Отсутствие просрочек в течение 12 месяцев заметно улучшит решение");

  if (f.inquiries_30d > 4) add("INQUIRIES", "Запросы в БКИ за 30 дней", String(f.inquiries_30d), -20, "Много заявок в разные банки за короткий срок снижает оценку");
  if (f.tax_arrears > 0) add("TAX", "Задолженность по налогам", `${fmt(f.tax_arrears)} ₽`, -40, "Погасите задолженность по налогам перед подачей заявки");

  if (f.is_bank_client) add("RELATIONSHIP", "Клиент банка", `${f.account_months} мес., обороты подтверждены`, f.account_months >= 12 ? 25 : 10);
  else add("RELATIONSHIP", "Клиент банка", "нет счёта", 0, "Обороты по счёту в банке позволяют подтвердить выручку");

  const risk = sectorRisk(f.okved);
  add("SECTOR", "Отраслевой риск", { LOW: "низкий", MEDIUM: "средний", HIGH: "повышенный" }[risk]!, { LOW: 10, MEDIUM: 0, HIGH: -20 }[risk]!);

  if (f.collateral_value > 0 || f.has_guarantee)
    add("SECURITY", "Обеспечение", f.collateral_value > 0 ? "залог" : "поручительство собственника", f.collateral_value > 0 ? 20 : 10);

  return [BASE_SCORE + factors.reduce((a, x) => a + x.points, 0), factors];
}

// ---------------------------------------------------------------- 3. credit logic

export function maxAmountFor(p: ProductTerms, f: Features, rate: number, term: number) {
  const maxPayment = monthlyCashFlow(f) / DSCR_MIN - f.existing_monthly_payments;
  let limit = maxPrincipal(maxPayment, rate, term);
  limit = f.collateral_value > 0 ? Math.min(limit, f.collateral_value * 0.7 + f.revenue_annual * 0.2) : Math.min(limit, f.revenue_annual * UNSECURED_REVENUE_CAP);
  if (p.requires_account) limit = Math.min(limit, f.avg_turnover_in * OVERDRAFT_TURNOVER_CAP);
  limit = Math.min(limit, p.max_amount);
  return Math.max(roundDown(limit), 0);
}

export function makeOffer(p: ProductTerms, amount: number, term: number, rate: number, kind: string, note: string): Offer {
  const pay = annuity(amount, rate, term);
  return {
    kind, product_code: p.code, product_name: p.name, amount, term_months: term, rate,
    monthly_payment: r2(pay), total_payment: r2(pay * term), overpayment: r2(pay * term - amount), note,
  };
}

export function decide(f: Features, p: ProductTerms, amount: number, term: number, keyRate: number, autoLimit: number, altProducts: ProductTerms[] = []) {
  const { stops, manual } = policyChecks(f);
  const [score, factors] = scorecard(f);
  const grade = gradeFor(score);
  const rate = rateFor(p, grade, f.is_bank_client, keyRate);
  const cf = monthlyCashFlow(f);
  const maxPayment = cf / DSCR_MIN - f.existing_monthly_payments;
  const reqPayment = annuity(amount, rate, term);
  const total = f.existing_monthly_payments + reqPayment;
  const dscr = total > 0 ? cf / total : 0;
  const maxAmount = maxAmountFor(p, f, rate, term);

  const eligibility = productEligibility(p, f);
  if (p.collateral_required && f.collateral_value > 0) manual.push({ code: "MT05", label: "Требуется оценка и проверка залога специалистом" });
  if (amount > autoLimit) manual.push({ code: "MT06", label: `Сумма превышает лимит автоматического решения (${fmt(autoLimit)} ₽)` });
  if (grade === "C" || grade === "D") manual.push({ code: "MT07", label: `Пограничный рейтинг ${grade}: нужна экспертная оценка` });

  const buildAlternatives = () => {
    const alts: Offer[] = [];
    if (maxAmount >= p.min_amount)
      alts.push(makeOffer(p, maxAmount, term, rate, "REDUCED_AMOUNT", "Меньшая сумма на тот же срок — платёж укладывается в денежный поток"));
    for (let t = term + 6; t <= p.max_term; t += 6) {
      if (amount <= maxAmountFor(p, f, rate, t)) {
        alts.push(makeOffer(p, amount, t, rate, "LONGER_TERM", "Та же сумма на более длинный срок — ниже ежемесячный платёж"));
        break;
      }
    }
    for (const alt of altProducts) {
      if (alt.code === p.code || productEligibility(alt, f).length) continue;
      const altRate = rateFor(alt, grade, f.is_bank_client, keyRate);
      const altTerm = Math.min(Math.max(term, alt.min_term), alt.max_term);
      const altAmount = Math.min(amount, maxAmountFor(alt, f, altRate, altTerm));
      if (altAmount >= alt.min_amount && altRate < rate) {
        const why = alt.eligible_okved_prefixes?.length ? "льготная ставка по программе поддержки МСП" : `ставка ниже на ${(rate - altRate).toFixed(2)} п.п.`;
        alts.push(makeOffer(alt, altAmount, altTerm, altRate, "OTHER_PRODUCT", `${alt.name}: ${why}`));
        break;
      }
    }
    return alts.slice(0, 3);
  };

  let outcome: string;
  let reasons: string[];
  let alternatives: Offer[] = [];
  if (stops.length) {
    outcome = "REJECT";
    reasons = stops.map((s) => s.label);
  } else if (grade === "E") {
    outcome = "REJECT";
    reasons = ["Уровень кредитного риска выше допустимого по политике банка"];
  } else if (eligibility.length) {
    reasons = eligibility;
    alternatives = buildAlternatives();
    outcome = alternatives.length ? "COUNTER_OFFER" : "REJECT";
  } else if (amount <= maxAmount && amount >= p.min_amount) {
    outcome = manual.length ? "MANUAL_REVIEW" : "APPROVE";
    reasons = manual.length ? manual.map((m) => m.label) : ["Заявка соответствует кредитной политике"];
  } else {
    alternatives = buildAlternatives();
    if (!alternatives.length) {
      outcome = "REJECT";
      reasons = ["Денежного потока бизнеса недостаточно для обслуживания кредита"];
    } else {
      outcome = manual.length ? "MANUAL_REVIEW" : "COUNTER_OFFER";
      reasons = manual.length ? manual.map((m) => m.label)
        : [`Платёж по запрошенной сумме (${fmt(reqPayment)} ₽) превышает допустимый (${fmt(Math.max(maxPayment, 0))} ₽)`];
    }
  }

  let recommended: Offer | null = null;
  if ((outcome === "APPROVE" || outcome === "MANUAL_REVIEW") && amount <= maxAmount) recommended = makeOffer(p, amount, term, rate, "FULL", "Запрошенные условия");
  else if (alternatives.length) recommended = alternatives[0];

  return {
    model_version: MODEL_VERSION,
    score, grade, pd: pdFor(score), factors, stop_factors: stops, manual_triggers: manual, eligibility_issues: eligibility,
    affordability: {
      monthly_cash_flow: r2(cf), existing_payments: r2(f.existing_monthly_payments), max_payment: r2(Math.max(maxPayment, 0)),
      requested_payment: r2(reqPayment), dscr: r2(dscr), dscr_min: DSCR_MIN, rate, max_amount_for_term: maxAmount,
    },
    decision: {
      outcome, reasons, recommended_offer: recommended, alternatives,
      improvement_tips: [...factors].sort((a, b) => a.points - b.points).filter((x) => x.points < 0 && x.hint).map((x) => x.hint).slice(0, 3),
    },
  };
}
