/**
 * Демо-режим для статического хостинга (GitHub Pages): in-browser реализация API CreditFlow.
 * Повторяет контракты backend (/api/v1/*), конечный автомат статусов, этапы конвейера,
 * модель решения, ленту и ассистента. Данные хранятся в localStorage этого браузера.
 * Полная версия (PostgreSQL, воркеры, внешние системы, аудит) — docker compose up.
 */
import {
  AUTO_DECISION_LIMIT, COMMITTEE_LIMIT, DEMO_ACCOUNTS, DEMO_CLIENTS, EMPLOYEES, external, HISTORY, isValidInn, KEY_RATE, NEWS,
  OFFER_TTL_DAYS, parseBankStatement, PRODUCTS, STEP_DELAY_MS,
} from "./data";
import { annuity, decide, fmt, makeOffer, rateFor, schedule, type Features, type ProductTerms } from "./engine";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// ------------------------------------------------------------------ состояние

const STORE_KEY = "cf_demo_db_v1";
interface DB {
  seq: number;
  users: Any[]; companies: Any[]; products: Any[]; apps: Any[]; events: Any[]; docs: Any[];
  tasks: Any[]; notifs: Any[]; news: Any[]; interactions: Any[]; audit: Any[];
}
let db: DB | null = null;
let memoryOnly = false;

const now = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const r2 = (v: number) => Math.round(v * 100) / 100;

function save() {
  if (memoryOnly || !db) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch {
    memoryOnly = true;
  }
}

function load(): DB {
  if (db) return db;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) db = JSON.parse(raw);
  } catch {
    memoryOnly = true;
  }
  if (!db) {
    db = seed();
    save();
  }
  return db;
}

export function resetDemo() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
  db = null;
}

class HttpError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : "error");
    this.status = status;
    this.detail = detail;
  }
}
const fail = (status: number, detail: unknown): never => {
  throw new HttpError(status, detail);
};

// ------------------------------------------------------------------ автомат статусов

const STATUS_INFO: Record<string, { label: string; client_hint: string; stage: number }> = {
  DRAFT: { label: "Черновик", client_hint: "Заполните заявку — данные сохраняются автоматически.", stage: 1 },
  SUBMITTED: { label: "Отправлена", client_hint: "Заявка принята, начинаем проверку.", stage: 2 },
  VALIDATION: { label: "Проверка данных", client_hint: "Проверяем полноту и корректность сведений.", stage: 2 },
  INFO_REQUESTED: { label: "Нужна информация", client_hint: "Банку нужны уточнения — ответьте на запрос в заявке.", stage: 2 },
  ENRICHMENT: { label: "Запрос данных", client_hint: "Получаем сведения из ЕГРЮЛ, ФНС и бюро кредитных историй.", stage: 3 },
  SCORING: { label: "Оценка", client_hint: "Оцениваем заявку и подбираем условия.", stage: 3 },
  MANUAL_REVIEW: { label: "У специалиста", client_hint: "Заявку изучает кредитный специалист. Обычно это занимает до 4 часов.", stage: 3 },
  COMMITTEE_REVIEW: { label: "На согласовании", client_hint: "Решение согласуется с риск-менеджером.", stage: 3 },
  APPROVED: { label: "Одобрена", client_hint: "Кредит одобрен. Ознакомьтесь с условиями и примите предложение.", stage: 4 },
  COUNTER_OFFER: { label: "Есть предложение", client_hint: "Банк готов выдать кредит на других условиях — выберите подходящий вариант.", stage: 4 },
  REJECTED: { label: "Отказ", client_hint: "К сожалению, сейчас банк не может выдать кредит. Посмотрите рекомендации.", stage: 4 },
  OFFER_ACCEPTED: { label: "Готовим документы", client_hint: "Формируем кредитный договор.", stage: 5 },
  SIGNING: { label: "Подписание", client_hint: "Проверьте договор и подпишите его кодом из уведомлений.", stage: 5 },
  SIGNED: { label: "Подписан", client_hint: "Договор подписан, перечисляем деньги.", stage: 5 },
  DISBURSED: { label: "Деньги выданы", client_hint: "Деньги зачислены на счёт. График платежей — в заявке.", stage: 6 },
  CANCELLED: { label: "Отменена", client_hint: "Заявка отменена.", stage: 6 },
};
const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["VALIDATION", "CANCELLED"],
  VALIDATION: ["ENRICHMENT", "INFO_REQUESTED", "REJECTED", "CANCELLED"],
  INFO_REQUESTED: ["SUBMITTED", "CANCELLED"],
  ENRICHMENT: ["SCORING", "INFO_REQUESTED", "MANUAL_REVIEW", "CANCELLED"],
  SCORING: ["APPROVED", "COUNTER_OFFER", "REJECTED", "MANUAL_REVIEW", "CANCELLED"],
  MANUAL_REVIEW: ["APPROVED", "COUNTER_OFFER", "REJECTED", "INFO_REQUESTED", "COMMITTEE_REVIEW", "CANCELLED"],
  COMMITTEE_REVIEW: ["APPROVED", "COUNTER_OFFER", "REJECTED", "MANUAL_REVIEW", "CANCELLED"],
  APPROVED: ["OFFER_ACCEPTED", "CANCELLED"],
  COUNTER_OFFER: ["OFFER_ACCEPTED", "CANCELLED"],
  OFFER_ACCEPTED: ["SIGNING", "CANCELLED"],
  SIGNING: ["SIGNED", "CANCELLED"],
  SIGNED: ["DISBURSED"],
  REJECTED: [], DISBURSED: [], CANCELLED: [],
};
const FINAL = new Set(["REJECTED", "DISBURSED", "CANCELLED"]);
const CLIENT_CANCELLABLE = new Set(Object.keys(TRANSITIONS).filter((s) => !FINAL.has(s) && s !== "SIGNED"));
const AUTO_STAGE: Record<string, string> = { SUBMITTED: "ACCEPT", VALIDATION: "VALIDATE", ENRICHMENT: "ENRICH", SCORING: "SCORE", OFFER_ACCEPTED: "PREPARE_DOCS", SIGNED: "DISBURSE" };
const SYSTEM = { type: "SYSTEM", id: null, name: "Кредитный конвейер" };
type Actor = { type: string; id: string | null; name: string | null };

function logEvent(app: Any, type: string, message: string, actor: Actor, details: Any = {}, visible = true, from: string | null = null, to: string | null = null) {
  load().events.push({ id: uid(), application_id: app.id, created_at: now(), event_type: type, from_status: from, to_status: to, actor_type: actor.type,
    actor_id: actor.id, actor_name: actor.name, message, details, visible_to_client: visible });
}
function notify(app: Any, title: string, body: string, kind = "STATUS") {
  load().notifs.push({ id: uid(), company_id: app.company_id, application_id: app.id, kind, title, body, is_read: false, created_at: now() });
}

function transition(app: Any, to: string, actor: Actor, message?: string, delayMs = 0) {
  const src = app.status;
  if (!TRANSITIONS[src].includes(to)) fail(409, `Переход ${src} → ${to} недопустим`);
  app.status = to;
  const t = now();
  if (to === "SUBMITTED" && !app.submitted_at) app.submitted_at = t;
  if (["APPROVED", "COUNTER_OFFER", "REJECTED"].includes(to) && !app.decided_at) app.decided_at = t;
  if (FINAL.has(to)) app.closed_at = t;
  app.updated_at = t;
  app.version++;
  const info = STATUS_INFO[to];
  const msg = message || info.client_hint;
  logEvent(app, "STATUS_CHANGED", msg, actor, {}, true, src, to);
  if (!["VALIDATION", "ENRICHMENT", "SCORING", "SUBMITTED"].includes(to)) {
    notify(app, `Заявка ${app.number}: ${info.label}`, msg, ["INFO_REQUESTED", "APPROVED", "COUNTER_OFFER", "SIGNING"].includes(to) ? "ACTION_REQUIRED" : "STATUS");
  }
  const stage = AUTO_STAGE[to];
  if (stage) load().tasks.push({ id: uid(), application_id: app.id, stage, status: "PENDING", run_after: Date.now() + delayMs });
}

// ------------------------------------------------------------------ конвейер

const DOC_LABELS: Record<string, string> = {
  FIN_STATEMENTS: "Бухгалтерская отчётность за последний год", BANK_STATEMENT: "Выписка по расчётному счёту за 6–12 месяцев (CSV)",
  COLLATERAL_DOCS: "Документы по залогу (право собственности, оценка)", OTHER: "Иной документ", CONTRACT: "Кредитный договор",
};
const PURPOSE_LABELS: Record<string, string> = {
  EQUIPMENT: "покупка оборудования или транспорта", WORKING_CAPITAL: "пополнение оборотных средств, закупка товара",
  CASH_GAP: "кассовый разрыв: зарплата, налоги, аренда", EXPANSION: "развитие: новая точка, направление",
  REAL_ESTATE: "покупка или ремонт помещения", REFINANCE: "рефинансирование других кредитов", TENDER: "исполнение госконтракта или тендера",
};

const productOf = (code: string) => load().products.find((p) => p.code === code);
const companyOf = (id: string) => load().companies.find((c) => c.id === id);
const docsOf = (appId: string) => load().docs.filter((d) => d.application_id === appId);
const docTypes = (app: Any) => new Set(docsOf(app.id).map((d) => d.doc_type));
const terms = (p: Any): ProductTerms => ({ ...p });

function requiredDocuments(app: Any): string[] {
  const req = [...(productOf(app.product_code).required_documents || [])];
  if (app.amount > AUTO_DECISION_LIMIT && !req.includes("FIN_STATEMENTS")) req.push("FIN_STATEMENTS");
  return req;
}

function requestInfo(app: Any, items: Any[], message: string, by = "SYSTEM") {
  app.info_request = { items, message, requested_at: now(), by, response: null };
  app.info_rounds++;
  transition(app, "INFO_REQUESTED", SYSTEM, message + ": " + items.map((i) => i.text).join("; "));
}

function buildFeatures(app: Any): Features {
  const e = app.enrichment || {};
  const eg = e.egrul || {}, fns = e.fns || {}, bki = e.bki || {}, af = e.antifraud || {}, acc = e.accounts || {};
  const fin = app.form_data?.financials || {}, col = app.form_data?.collateral || {};
  const company = companyOf(app.company_id);
  const reg = new Date(eg.registration_date || company.registration_date);
  const t = new Date();
  const age = (t.getFullYear() - reg.getFullYear()) * 12 + t.getMonth() - reg.getMonth();
  const declaredRev = Number(fin.revenue_last_year || 0), declaredExp = Number(fin.expenses_last_year || 0);
  const statement = docsOf(app.id).find((d) => d.doc_type === "BANK_STATEMENT" && d.parsed?.ok)?.parsed;
  let revenue: number, verified: boolean;
  if (statement) [revenue, verified] = [statement.annualized_inflow, true];
  else if (fns.revenue_last_year) [revenue, verified] = [fns.revenue_last_year, true];
  else if (acc.is_client) [revenue, verified] = [acc.avg_monthly_inflow * 12, true];
  else [revenue, verified] = [declaredRev, false];
  let expRatio = declaredRev ? declaredExp / declaredRev : 0.85;
  if (fns.expenses_last_year && fns.revenue_last_year) expRatio = Math.max(expRatio, fns.expenses_last_year / fns.revenue_last_year);
  const bkiPayments = (bki.active_loans || []).reduce((a: number, l: Any) => a + Number(l.monthly_payment || 0), 0);
  const flags = fns.flags || {};
  return {
    business_age_months: age, revenue_annual: revenue, expenses_annual: revenue * expRatio,
    existing_monthly_payments: Math.max(Number(fin.existing_monthly_payments || 0), bkiPayments),
    okved: eg.okved_main?.code || company.okved || "", company_status: eg.found === false ? "NOT_FOUND" : eg.status || "ACTIVE",
    bki_score: bki.score ?? null, max_overdue_days_12m: bki.max_overdue_days_12m || 0, current_overdue_days: bki.current_overdue_days || 0,
    inquiries_30d: bki.inquiries_30d || 0, tax_arrears: fns.tax_arrears || 0, is_bank_client: !!acc.is_client, account_months: acc.account_months || 0,
    avg_turnover_in: acc.avg_monthly_inflow || 0, disqualified_director: !!flags.disqualified_director, mass_address: !!flags.mass_address,
    unreliable_info: !!flags.unreliable_info, antifraud_level: af.risk_level || "LOW", collateral_value: Number(col.estimated_value || 0),
    has_guarantee: !!app.form_data?.owner_guarantee, revenue_verified: verified, sources_unavailable: e.unavailable || [],
  };
}

function runDecision(app: Any, amount?: number, term?: number, product?: Any) {
  const features = buildFeatures(app);
  const alts = load().products.filter((p) => p.is_active).map(terms);
  const res: Any = decide(features, terms(product || productOf(app.product_code)), amount || app.amount, term || app.term_months, KEY_RATE, AUTO_DECISION_LIMIT, alts);
  res.features = features;
  res.calculated_at = now();
  return res;
}

function setOffer(app: Any, options: Any[]) {
  const p = productOf(app.product_code);
  const cond = ["Целевое использование средств: " + (app.purpose_comment || PURPOSE_LABELS[app.purpose] || "развитие бизнеса")];
  if (p.guarantee_required) cond.push("Поручительство собственника бизнеса");
  if (p.collateral_required) cond.push(`Залог: ${app.form_data?.collateral?.description || "имущество"}`);
  if (p.code === "GOV_1764") cond.push("Льготная ставка по программе поддержки МСП — при соблюдении условий программы");
  cond.push("Досрочное погашение без комиссий");
  const valid = new Date(Date.now() + OFFER_TTL_DAYS * 86400_000).toISOString().slice(0, 10);
  app.offer = { options, valid_until: valid, conditions: cond, selected_index: null };
}

function renderContract(app: Any, o: Any, no: string) {
  const c = companyOf(app.company_id);
  const f = (v: number) => v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${no}</title><body style="font-family:Georgia,serif;max-width:760px;margin:40px auto;line-height:1.5">
<h2>Кредитный договор № ${no}</h2><p><i>Документ сформирован демо-версией CreditFlow. Синтетические данные, юридической силы не имеет.</i></p>
<p><b>Заёмщик:</b> ${c.name}, ИНН ${c.inn}, ОГРН ${c.ogrn || "—"}, адрес: ${c.address || "—"}.</p><p><b>Продукт:</b> ${o.product_name}</p>
<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><td>Сумма кредита</td><td>${f(o.amount)} ₽</td></tr><tr><td>Срок</td><td>${o.term_months} мес.</td></tr>
<tr><td>Процентная ставка</td><td>${o.rate}% годовых</td></tr><tr><td>Ежемесячный аннуитетный платёж</td><td>${f(o.monthly_payment)} ₽</td></tr>
<tr><td>Полная сумма выплат</td><td>${f(o.total_payment)} ₽</td></tr></table><h3>Условия</h3><ul>${(app.offer.conditions || []).map((x: string) => `<li>${x}</li>`).join("")}</ul>
<p>Подписывая договор простой электронной подписью, Заёмщик подтверждает согласие с условиями.</p></body></html>`;
}

const STAGES: Record<string, (app: Any) => void> = {
  ACCEPT(app) {
    if (app.status === "SUBMITTED") transition(app, "VALIDATION", SYSTEM, undefined, STEP_DELAY_MS);
  },
  VALIDATE(app) {
    if (app.status !== "VALIDATION") return;
    const p = productOf(app.product_code);
    const fin = app.form_data?.financials || {}, col = app.form_data?.collateral || {};
    const errors: string[] = [], requests: Any[] = [];
    if (!(p.min_amount <= app.amount && app.amount <= p.max_amount)) errors.push(`Сумма вне диапазона продукта (${fmt(p.min_amount)}–${fmt(p.max_amount)} ₽)`);
    if (!(p.min_term <= app.term_months && app.term_months <= p.max_term)) errors.push(`Срок вне диапазона продукта (${p.min_term}–${p.max_term} мес.)`);
    if (!app.consents?.bki || !app.consents?.personal_data) requests.push({ code: "CONSENT", type: "field", text: "Подтвердите согласия на запрос в БКИ и обработку данных" });
    if (!fin.revenue_last_year) requests.push({ code: "REVENUE", type: "field", text: "Укажите выручку за последний год" });
    if (p.collateral_required && !Number(col.estimated_value || 0)) requests.push({ code: "COLLATERAL", type: "field", text: "Укажите предмет залога и его оценочную стоимость" });
    const have = docTypes(app);
    for (const dt of requiredDocuments(app)) if (!have.has(dt)) requests.push({ code: `DOC_${dt}`, type: "document", doc_type: dt, text: `Загрузите: ${DOC_LABELS[dt]}` });
    app.validation = { checked_at: now(), errors, requests };
    if (errors.length) {
      app.decision = { outcome: "REJECT", reasons: errors, by: "SYSTEM" };
      transition(app, "REJECTED", SYSTEM, "Параметры заявки не соответствуют условиям продукта: " + errors.join("; "));
      return;
    }
    if (requests.length) return requestInfo(app, requests, "Для продолжения рассмотрения нужны дополнительные сведения");
    logEvent(app, "VALIDATION_PASSED", "Данные заявки заполнены полностью и корректно", SYSTEM);
    transition(app, "ENRICHMENT", SYSTEM, undefined, STEP_DELAY_MS);
  },
  ENRICH(app) {
    if (app.status !== "ENRICHMENT") return;
    const inn = companyOf(app.company_id).inn;
    app.enrichment = { fetched_at: now(), unavailable: [], egrul: external.egrul(inn), fns: external.fns(inn), bki: external.bki(inn), antifraud: external.antifraud(inn), accounts: external.accounts(inn) };
    logEvent(app, "ENRICHMENT_DONE", "Получены сведения из внешних источников", SYSTEM, { sources: ["egrul", "fns", "bki", "antifraud", "accounts"] });
    const declared = Number(app.form_data?.financials?.revenue_last_year || 0);
    const fnsRev = Number(app.enrichment.fns.revenue_last_year || 0);
    const proof = docTypes(app).has("BANK_STATEMENT") || docTypes(app).has("FIN_STATEMENTS");
    if (fnsRev && declared && Math.abs(declared - fnsRev) / fnsRev > 0.35 && !proof && app.info_rounds < 2) {
      return requestInfo(app, [{ code: "REVENUE_MISMATCH", type: "document", doc_type: "BANK_STATEMENT",
        text: `Указанная выручка (${fmt(declared)} ₽) отличается от данных ФНС (${fmt(fnsRev)} ₽). Загрузите выписку по счёту за 6–12 месяцев или отчётность — это подтвердит обороты.` }], "Нужно подтвердить выручку");
    }
    transition(app, "SCORING", SYSTEM, undefined, STEP_DELAY_MS);
  },
  SCORE(app) {
    if (app.status !== "SCORING") return;
    const res = runDecision(app);
    app.scoring = res;
    const d = res.decision;
    logEvent(app, "SCORING_DONE", `Скоринг: ${res.score} баллов, рейтинг ${res.grade}, PD ${(res.pd * 100).toFixed(1)}%. Рекомендация: ${d.outcome}`, SYSTEM, {}, false);
    if (d.outcome === "APPROVE") {
      setOffer(app, [d.recommended_offer]);
      app.decision = { outcome: "APPROVE", by: "SYSTEM", reasons: d.reasons, at: now() };
      transition(app, "APPROVED", SYSTEM, "Кредит одобрен автоматически. Ознакомьтесь с условиями предложения.");
    } else if (d.outcome === "COUNTER_OFFER") {
      setOffer(app, d.alternatives);
      app.decision = { outcome: "COUNTER_OFFER", by: "SYSTEM", reasons: d.reasons, at: now() };
      transition(app, "COUNTER_OFFER", SYSTEM, "Банк готов выдать кредит на скорректированных условиях. Выберите подходящий вариант.");
    } else if (d.outcome === "MANUAL_REVIEW") {
      app.decision = { outcome: "MANUAL_REVIEW", by: "SYSTEM", reasons: d.reasons, at: now() };
      transition(app, "MANUAL_REVIEW", SYSTEM);
    } else {
      app.decision = { outcome: "REJECT", by: "SYSTEM", reasons: d.reasons, tips: d.improvement_tips, at: now() };
      transition(app, "REJECTED", SYSTEM, "Банк не может выдать кредит на текущих данных. Посмотрите, что можно улучшить.");
    }
  },
  PREPARE_DOCS(app) {
    if (app.status !== "OFFER_ACCEPTED") return;
    const o = app.offer.options[app.offer.selected_index];
    const no = `КД-${app.number.split("-").slice(1).join("-")}`;
    const html = renderContract(app, o, no);
    load().docs.push({ id: uid(), application_id: app.id, doc_type: "CONTRACT", filename: `${no}.html`, content_type: "text/html", size: html.length, sha256: "", parsed: {}, created_at: now(), content: html });
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    app.sign_code = code;
    app.loan = { contract_number: no };
    notify(app, "Код для подписания договора", `Ваш код простой электронной подписи для договора ${no}: ${code}. Никому его не сообщайте — сотрудники банка его не спрашивают.`, "SIGN_CODE");
    transition(app, "SIGNING", SYSTEM, "Договор сформирован. Проверьте условия и подпишите его кодом из уведомлений.");
  },
  DISBURSE(app) {
    if (app.status !== "SIGNED") return;
    const o = app.offer.options[app.offer.selected_index];
    const res = external.disburse(companyOf(app.company_id).inn);
    app.loan = { ...app.loan, ...res, amount: o.amount, rate: o.rate, term_months: o.term_months, monthly_payment: o.monthly_payment, schedule: schedule(o.amount, o.rate, o.term_months, new Date()) };
    transition(app, "DISBURSED", SYSTEM, `${fmt(o.amount)} ₽ зачислены на счёт ${res.account}. График платежей доступен в заявке.`);
  },
};

/** Выполнить все задачи, время которых наступило (ленивая модель воркера: вызывается на каждом запросе). */
function processDue(ignoreDelay = false) {
  const d = load();
  for (let guard = 0; guard < 100; guard++) {
    const task = d.tasks.filter((t) => t.status === "PENDING" && (ignoreDelay || t.run_after <= Date.now())).sort((a, b) => a.run_after - b.run_after)[0];
    if (!task) break;
    task.status = "DONE";
    const app = d.apps.find((a) => a.id === task.application_id);
    if (app) STAGES[task.stage](app);
  }
  d.tasks = d.tasks.filter((t) => t.status === "PENDING");
}

// ------------------------------------------------------------------ сериализация

function slaMinutes(app: Any) {
  if (!["MANUAL_REVIEW", "COMMITTEE_REVIEW"].includes(app.status)) return null;
  const ev = load().events.filter((e) => e.application_id === app.id && e.to_status === app.status).pop();
  return Math.floor((Date.now() - new Date(ev?.created_at || app.updated_at).getTime()) / 60000);
}

function toShort(app: Any) {
  const c = companyOf(app.company_id);
  return {
    id: app.id, number: app.number, product_code: app.product_code, amount: app.amount, term_months: app.term_months, purpose: app.purpose,
    status: app.status, status_label: STATUS_INFO[app.status].label, created_at: app.created_at, updated_at: app.updated_at,
    submitted_at: app.submitted_at || null, decided_at: app.decided_at || null, company_name: c.name, company_inn: c.inn,
    grade: app.scoring?.grade || null, score: app.scoring?.score ?? null, assigned_to: app.assigned_to || null, sla_minutes: slaMinutes(app),
  };
}

function withoutContent(d: Any) {
  const copy = { ...d };
  delete copy.content;
  return copy;
}

const NEXT_ACTION: Record<string, string> = {
  DRAFT: "Заполните и отправьте заявку", INFO_REQUESTED: "Ответьте на запрос банка", APPROVED: "Примите предложение банка",
  COUNTER_OFFER: "Выберите подходящий вариант предложения", SIGNING: "Подпишите кредитный договор",
};

function productOut(p: Any) {
  return { ...p, rate_from: rateFor(terms(p), "A", false, KEY_RATE) };
}

function toFull(app: Any, employee: boolean) {
  const info = STATUS_INFO[app.status];
  const events = load().events.filter((e) => e.application_id === app.id && (employee || e.visible_to_client));
  const decision = { ...(app.decision || {}) };
  if (!employee) delete decision.proposal;
  let scoring: Any = null;
  if (employee) scoring = app.scoring || {};
  else if (app.scoring?.factors) {
    scoring = {
      factors: app.scoring.factors.map((f: Any) => ({ label: f.label, value: f.value, impact: f.points > 0 ? "positive" : f.points < 0 ? "negative" : "neutral", hint: f.hint })),
      affordability: { monthly_cash_flow: app.scoring.affordability.monthly_cash_flow, max_payment: app.scoring.affordability.max_payment, max_amount_for_term: app.scoring.affordability.max_amount_for_term },
      improvement_tips: app.scoring.decision.improvement_tips,
    };
  }
  return {
    ...toShort(app), purpose_comment: app.purpose_comment || null, form_data: app.form_data || {}, consents: app.consents || {}, validation: app.validation || {},
    info_request: app.info_request || {}, offer: app.offer || {}, decision, loan: app.loan || {}, status_hint: info.client_hint, stage: info.stage,
    next_action: NEXT_ACTION[app.status] || null, required_documents: requiredDocuments(app),
    documents: docsOf(app.id).map(withoutContent), events, product: productOut(productOf(app.product_code)), company: companyOf(app.company_id),
    enrichment: employee ? app.enrichment || {} : null, scoring,
  };
}

// ------------------------------------------------------------------ лента новостей

const SEGMENT_LABEL: Record<string, string> = { micro: "микробизнеса", small: "малого бизнеса", medium: "среднего бизнеса" };
const CATEGORY_LABEL: Record<string, string> = { MARKET: "Рынок и ставки", SUPPORT: "Господдержка", TAX: "Налоги и отчётность", PRODUCT: "Продукты банка", EDUCATION: "Финграмотность", INDUSTRY: "Отраслевые новости" };

function rankFeed(company: Any, userId: string | null) {
  const d = load();
  const apps = d.apps.filter((a) => a.company_id === company.id);
  const statuses = new Set(apps.map((a) => a.status));
  const products = new Set(apps.map((a) => a.product_code));
  const hidden = new Set<string>();
  const clicks: Record<string, number> = {};
  for (const i of d.interactions.filter((x) => x.user_id === userId)) {
    const n = d.news.find((x) => x.id === i.news_id);
    if (!n) continue;
    if (i.action === "HIDE") hidden.add(n.id);
    else clicks[n.category] = (clicks[n.category] || 0) + 1;
  }
  const okved = company.okved || "";
  const out = [];
  for (const n of d.news.filter((x) => x.is_active && !hidden.has(x.id))) {
    const t = n.tags || {};
    let score = n.priority;
    const reasons: string[] = [];
    if (t.okved?.length) {
      if (!t.okved.some((p: string) => okved.startsWith(p))) continue;
      score += 40;
      reasons.push(`Ваш вид деятельности: ${okved} ${company.okved_name || ""}`.trim());
    }
    if (t.legal_forms?.length) {
      if (!t.legal_forms.includes(company.legal_form)) continue;
      score += 10;
      reasons.push("Актуально для " + (company.legal_form === "IP" ? "индивидуальных предпринимателей" : "юрлиц"));
    }
    if (t.regions?.length) {
      if (!t.regions.includes(company.region)) continue;
      score += 20;
      reasons.push(`Ваш регион: ${company.region}`);
    }
    if (t.segments?.length) {
      if (!t.segments.includes(company.segment)) continue;
      score += 10;
      reasons.push(`Для ${SEGMENT_LABEL[company.segment] || company.segment}`);
    }
    if (t.statuses?.length) {
      const hit = t.statuses.filter((s: string) => statuses.has(s)).sort();
      if (!hit.length) continue;
      score += 45;
      reasons.push(`Связано с вашей заявкой (этап «${STATUS_INFO[hit[0]].label}»)`);
    }
    if (t.products?.length) {
      const hit = t.products.filter((p: string) => products.has(p)).sort();
      if (hit.length) {
        score += 25;
        reasons.push(`Вы интересовались продуктом «${productOf(hit[0])?.name || ""}»`);
      }
    }
    if (clicks[n.category]) {
      score += Math.min(15, 5 * clicks[n.category]);
      reasons.push(`Вы читаете раздел «${CATEGORY_LABEL[n.category] || n.category}»`);
    }
    score += Math.max(0, 20 - Math.floor((Date.now() - new Date(n.published_at).getTime()) / 86400_000));
    if (!reasons.length) reasons.push("Важно для всех предпринимателей");
    out.push({ ...n, relevance: Math.round(score * 10) / 10, reasons });
  }
  out.sort((a, b) => b.relevance - a.relevance || b.published_at.localeCompare(a.published_at));
  return out.slice(0, 20);
}

// ------------------------------------------------------------------ ассистент (правила + база знаний)

const PURPOSE_KEYWORDS: [string, RegExp][] = [
  ["EQUIPMENT", /оборудован|станок|станк|печ[ьи]|техник|машин|автомобил|грузовик|фур[уы]|трактор|линию|кофемашин/u],
  ["REAL_ESTATE", /помещени|недвижим|склад|офис|здани|ремонт/u],
  ["CASH_GAP", /кассов|разрыв|зарплат|налог|аренд|отсрочк/u],
  ["TENDER", /госконтракт|тендер|44-фз|223-фз|контракт/u],
  ["REFINANCE", /рефинанс|перекредит|погасить другой|другой кредит/u],
  ["EXPANSION", /открыт|филиал|точк|расшир|масштаб|нов(ое|ый) направлени/u],
  ["WORKING_CAPITAL", /закуп|товар|сырь|оборот|материал|запас|сезон/u],
];
const KB = [
  { keys: /статус|что происходит|где заявк|этап/u, title: "Статусы заявки", text: "Заявка проходит этапы: проверка данных → запрос сведений из ЕГРЮЛ, ФНС и БКИ → оценка → решение → подписание договора → выдача. Текущий этап и следующий шаг всегда видны на странице заявки." },
  { keys: /документ|какие нужн|выписк|отчетност|отчётност/u, title: "Документы", text: "Для экспресс-кредита документы обычно не нужны: данные о компании мы получаем из ЕГРЮЛ и ФНС сами. Выписка по счёту в CSV ускоряет решение, если вы не клиент банка. Для сумм больше 10 млн ₽ нужна бухгалтерская отчётность, для инвестиционного кредита — документы по залогу." },
  { keys: /dscr|дскр|нагрузк|сколько дадут|лимит|максимальн/u, title: "Как считается лимит", text: "Лимит считается по денежному потоку: ежемесячные платежи по всем кредитам не должны превышать денежный поток бизнеса, делённый на 1,3 (коэффициент DSCR). Чем выше подтверждённая выручка и ниже текущие платежи, тем больше лимит." },
  { keys: /ставк|процент|дорого|ключев/u, title: "Ставка", text: "Ставка = ключевая ставка ЦБ (сейчас 14%) + надбавка продукта + надбавка за риск по рейтингу. Клиентам с расчётным счётом в банке — скидка 0,5 п.п. По льготной программе МСП ставка ограничена." },
  { keys: /льгот|господдерж|1764|программ|мсп/u, title: "Льготная программа", text: "Льготный кредит по программе поддержки МСП доступен компаниям из приоритетных отраслей: производство, сельское хозяйство, IT, логистика, туризм, образование и здравоохранение. Ставка ниже рыночной, если нет долгов по налогам." },
  { keys: /отказ|почему не|не одобр/u, title: "Почему может быть отказ", text: "Основные причины: просрочки по кредитам, долги по налогам, отрицательный денежный поток, срок бизнеса меньше 3 месяцев, ограничения в ЕГРЮЛ. В заявке показано, что повлияло на решение и что можно улучшить." },
  { keys: /подпис|код|договор|эп|электронн/u, title: "Подписание", text: "После принятия предложения формируется договор. Его подписывают кодом простой электронной подписи — код приходит в уведомления личного кабинета. Сотрудники банка никогда не спрашивают этот код." },
  { keys: /залог|обеспечен|поручител/u, title: "Залог и поручительство", text: "Экспресс-кредит выдаётся без залога. Для оборотного кредита нужно поручительство собственника. Инвестиционный кредит требует залога (недвижимость, оборудование, транспорт): с залогом лимит выше, а ставка ниже." },
  { keys: /быстр|сколько ждать|срок рассмотр|когда/u, title: "Сроки", text: "Экспресс-кредит до 10 млн ₽ рассматривается автоматически за несколько минут. Если заявке нужна экспертиза, её изучает специалист — обычно до 4 рабочих часов." },
  { keys: /досрочн|погасить раньше/u, title: "Досрочное погашение", text: "Погасить кредит досрочно можно в любой момент без комиссий — полностью или частично." },
];
const AMOUNT_RE = /(\d+(?:[.,]\d+)?)\s*(млрд|млн|миллион[а-яё]*|тыс[а-яё]*|т\.р\.|к(?![а-яё])|₽|руб[а-яё]*)?/gu;
const TERM_RE = /(\d+(?:[.,]\d+)?)\s*(год|года|лет|мес[а-яё]*)/u;

function parseNeed(text: string) {
  const t = text.toLowerCase().replace(/ /g, " ");
  const purpose = PURPOSE_KEYWORDS.find(([, rx]) => rx.test(t))?.[0] || null;
  let amount: number | null = null;
  for (const m of t.matchAll(AMOUNT_RE)) {
    const num = Number(m[1].replace(",", "."));
    const unit = (m[2] || "").toLowerCase();
    const after = t.slice((m.index || 0) + m[0].length, (m.index || 0) + m[0].length + 6);
    if (/^\s*(год|лет|мес)/u.test(after)) continue;
    if (unit.startsWith("млрд")) amount = num * 1e9;
    else if (unit.startsWith("млн") || unit.startsWith("миллион")) amount = num * 1e6;
    else if (unit.startsWith("тыс") || unit.startsWith("т.р") || unit === "к") amount = num * 1e3;
    else if (num >= 10_000) amount = num;
    if (amount) break;
  }
  let term: number | null = null;
  const tm = t.match(TERM_RE);
  if (tm) {
    const n = Number(tm[1].replace(",", "."));
    term = tm[2].startsWith("год") || tm[2].startsWith("лет") ? Math.round(n * 12) : Math.round(n);
  } else if (/на\s+год(?![а-яё])/u.test(t)) term = 12;
  else if (/полгода/u.test(t)) term = 6;
  const has_collateral = /залог|есть недвижим|в собственности|под залог/u.test(t) && !/без залога/u.test(t);
  return { purpose, amount, term_months: term, has_collateral };
}

function recommend(company: Any, purpose: string | null, amount: number | null, term: number | null, hasCollateral: boolean, isClient = false) {
  const okved = company?.okved || "";
  const recs = load().products.filter((p) => p.is_active).sort((a, b) => a.sort_order - b.sort_order).map((p) => {
    let fit = 0;
    const why: string[] = [], blockers: string[] = [];
    if (purpose && p.purposes.includes(purpose)) {
      fit += 40;
      why.push(`подходит для цели «${PURPOSE_LABELS[purpose]}»`);
    } else if (purpose) fit -= 25;
    if (amount) {
      if (p.min_amount <= amount && amount <= p.max_amount) fit += 20;
      else { fit -= 30; blockers.push(`сумма ${p.min_amount / 1e6}–${p.max_amount / 1e6} млн ₽`); }
    }
    if (term) {
      if (p.min_term <= term && term <= p.max_term) fit += 10;
      else { fit -= 10; blockers.push(`срок ${p.min_term}–${p.max_term} мес.`); }
    }
    if (p.collateral_required) {
      if (hasCollateral) { fit += 10; why.push("есть залог — ставка ниже, лимит выше"); }
      else { fit -= 35; blockers.push("нужен залог"); }
    } else if (!hasCollateral) { fit += 5; why.push("без залога"); }
    if (p.eligible_okved_prefixes.length) {
      if (okved && p.eligible_okved_prefixes.some((x: string) => okved.startsWith(x))) { fit += 30; why.push("ваша отрасль входит в программу господдержки"); }
      else { fit -= 50; blockers.push("только для приоритетных отраслей"); }
    }
    if (p.requires_account) {
      if (isClient) { fit += 10; why.push("лимит считается по оборотам вашего счёта"); }
      else { fit -= 40; blockers.push("нужен расчётный счёт в банке"); }
    }
    if (p.code === "EXPRESS") why.push("решение онлайн за минуты");
    const rate = rateFor(terms(p), "A", isClient, KEY_RATE);
    const a = Math.min(Math.max(amount || p.min_amount, p.min_amount), p.max_amount);
    const t = Math.min(Math.max(term || 24, p.min_term), p.max_term);
    return { product_code: p.code, name: p.name, tagline: p.tagline, fit, reasons: why, limitations: blockers, rate_from: rate, example_amount: a, example_term: t,
      example_payment: r2(annuity(a, rate, t)), decision_time: p.decision_time };
  });
  return recs.sort((a, b) => b.fit - a.fit);
}

function chat(company: Any, message: string, app: Any | null) {
  const needLike = /нужн|хочу|надо|планир|купить|закуп|взять/u.test(message.toLowerCase()) && /\d/.test(message);
  if (needLike) {
    const parsed = parseNeed(message);
    const recs = recommend(company, parsed.purpose, parsed.amount, parsed.term_months, parsed.has_collateral).slice(0, 3);
    const top = recs[0];
    const lines = [
      `Понял задачу: ${PURPOSE_LABELS[parsed.purpose || ""] || "финансирование бизнеса"}${parsed.amount ? `, около ${fmt(parsed.amount)} ₽` : ""}${parsed.term_months ? ` на ${parsed.term_months} мес.` : ""}.`,
      `Лучше всего подходит «${top.name}»: ${top.reasons.slice(0, 3).join(", ") || top.tagline}. Ставка от ${top.rate_from}%, примерный платёж ${fmt(top.example_payment)} ₽/мес.`,
    ];
    return { answer: lines.join("\n"), engine: "rules", parsed, recommendations: recs, suggestions: [`Оформить «${top.name}»`, "Какие документы нужны?"] };
  }
  const ctx: string[] = [];
  if (app) {
    const st = STATUS_INFO[app.status];
    const parts = [`Заявка ${app.number}: ${productOf(app.product_code).name}, ${fmt(app.amount)} ₽ на ${app.term_months} мес. Текущий статус — «${st.label}». ${st.client_hint}`];
    if (app.status === "INFO_REQUESTED") parts.push("Банк просит: " + (app.info_request.items || []).map((i: Any) => i.text).join("; "));
    if (["APPROVED", "COUNTER_OFFER"].includes(app.status) && app.offer?.options?.length) {
      const o = app.offer.options[0];
      parts.push(`Предложение: ${fmt(o.amount)} ₽ на ${o.term_months} мес. под ${o.rate}%, платёж ${fmt(o.monthly_payment)} ₽ в месяц.`);
    }
    if (app.status === "REJECTED") {
      parts.push("Причины: " + (app.decision.reasons || []).join("; "));
      if (app.decision.tips?.length) parts.push("Что можно улучшить: " + app.decision.tips.join("; "));
    }
    ctx.push(parts.join(" "));
  }
  const ql = message.toLowerCase();
  ctx.push(...KB.filter((k) => k.keys.test(ql)).slice(0, 2).map((k) => `${k.title}: ${k.text}`));
  if (!ctx.length) ctx.push("Я помогаю подобрать кредит, объясняю статус заявки, условия и следующие шаги. Опишите задачу своими словами, например: «нужно 3 млн на новое оборудование на 2 года».");
  return { answer: ctx.join("\n\n"), engine: "rules", suggestions: ["Какие документы нужны?", "Как считается лимит?", "Сколько ждать решения?"] };
}

function analystSummary(app: Any) {
  const sc = app.scoring;
  if (!sc?.score) return { summary: "Скоринг ещё не выполнен.", engine: "rules" };
  const c = companyOf(app.company_id);
  const aff = sc.affordability;
  const neg = sc.factors.filter((f: Any) => f.points < 0), pos = sc.factors.filter((f: Any) => f.points > 0);
  const lines = [
    `${c.name} (ИНН ${c.inn}), ОКВЭД ${c.okved}, срок деятельности ${Math.floor(sc.features.business_age_months / 12)} г. Запрос: ${productOf(app.product_code).name}, ${fmt(app.amount)} ₽ на ${app.term_months} мес.`,
    `Рейтинг ${sc.grade} (${sc.score} б., PD ${(sc.pd * 100).toFixed(1)}%). Денежный поток ${fmt(aff.monthly_cash_flow)} ₽/мес, DSCR по запросу ${aff.dscr} (мин. ${aff.dscr_min}), макс. сумма на срок — ${fmt(aff.max_amount_for_term)} ₽.`,
    "Сильные стороны: " + (pos.slice(0, 3).map((f: Any) => `${f.label.toLowerCase()} (${f.value})`).join(", ") || "нет"),
    "Риски: " + (neg.slice(0, 3).map((f: Any) => `${f.label.toLowerCase()} (${f.value})`).join(", ") || "существенных нет"),
  ];
  if (sc.manual_triggers?.length) lines.push("Причины ручного рассмотрения: " + sc.manual_triggers.map((m: Any) => m.label).join("; "));
  if (app.enrichment?.egrul?.director) lines.push(`Руководитель по ЕГРЮЛ: ${app.enrichment.egrul.director.name}.`);
  const rec = sc.decision.recommended_offer;
  if (rec) lines.push(`Рекомендация системы: ${fmt(rec.amount)} ₽ на ${rec.term_months} мес. под ${rec.rate}%.`);
  return { summary: lines.join("\n"), engine: "rules", facts: lines };
}

// ------------------------------------------------------------------ сид

function companyFromEgrul(inn: string) {
  const eg = external.egrul(inn);
  return { id: uid(), inn, ogrn: eg.ogrn, name: eg.short_name, legal_form: eg.legal_form, okved: eg.okved_main.code, okved_name: eg.okved_main.name,
    region: eg.region, address: eg.address, director_name: eg.director?.name, registration_date: eg.registration_date, segment: eg.msp_category || "micro", employees: eg.employees };
}

let numSeq = 0;
function newNumber() {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  numSeq++;
  return `CF-${ymd}-${(Math.floor(Math.random() * 0xefff) + 0x1000 + numSeq).toString(16).toUpperCase().slice(-4)}`;
}

function seed(): DB {
  db = { seq: 0, users: [], companies: [], products: PRODUCTS.map((p) => ({ ...p, is_active: true })), apps: [], events: [], docs: [], tasks: [], notifs: [],
    news: NEWS().map((n) => ({ id: uid(), source: "Демо-контент CreditFlow", cta_label: null, cta_link: null, is_active: true, ...n })), interactions: [], audit: [] };
  for (const [email, name, pos, role] of EMPLOYEES) db.users.push({ id: uid(), email, full_name: name, position: pos, role, company_id: null });
  for (const [email, name, pos, inn] of DEMO_CLIENTS) {
    const c = companyFromEgrul(inn);
    db.companies.push(c);
    db.users.push({ id: uid(), email, full_name: name, position: pos, role: "CLIENT", company_id: c.id });
  }
  HISTORY.forEach(([inn, product, amount, term, purpose, collateral, docs, then], i) => {
    const c = companyFromEgrul(inn);
    db!.companies.push(c);
    const u = { id: uid(), email: `client${i + 1}@demo.ru`, full_name: c.director_name || c.name, position: "Руководитель", role: "CLIENT", company_id: c.id };
    db!.users.push(u);
    const fns = external.fns(inn);
    const app = createApp(u, { product_code: product, amount, term_months: term, purpose });
    app.form_data = { financials: { revenue_last_year: fns.revenue_last_year, expenses_last_year: fns.expenses_last_year, existing_monthly_payments: 0, employees: fns.avg_employees },
      collateral: { type: collateral ? "EQUIPMENT" : "NONE", estimated_value: collateral, description: collateral ? "Производственная линия (приобретаемое оборудование)" : null },
      contact: { name: u.full_name }, owner_guarantee: product === "WORKING_CAPITAL", company_confirmed: true };
    app.consents = { bki: true, personal_data: true };
    for (const dt of docs) db!.docs.push({ id: uid(), application_id: app.id, doc_type: dt, filename: `${dt.toLowerCase()}.pdf`, content_type: "application/pdf", size: 2048, sha256: "", parsed: {}, created_at: now() });
    const actor = { type: "CLIENT", id: u.id, name: u.full_name };
    transition(app, "SUBMITTED", actor, "Заявка отправлена в банк");
    processDue(true);
    if (then && ["APPROVED", "COUNTER_OFFER"].includes(app.status)) {
      app.offer.selected_index = 0;
      transition(app, "OFFER_ACCEPTED", actor, "Предложение принято");
      processDue(true);
      if (then === "DISBURSE") {
        transition(app, "SIGNED", actor, "Договор подписан простой электронной подписью");
        processDue(true);
      }
    }
  });
  return db;
}

function createApp(user: Any, body: Any) {
  const t = now();
  const app: Any = { id: uid(), number: newNumber(), company_id: user.company_id, created_by: user.id, product_code: body.product_code, amount: body.amount,
    term_months: body.term_months, purpose: body.purpose || null, purpose_comment: body.purpose_comment || null, status: "DRAFT",
    form_data: { contact: { name: user.full_name, position: user.position } }, consents: {}, validation: {}, enrichment: {}, scoring: {}, decision: {}, offer: {},
    info_request: {}, loan: {}, info_rounds: 0, assigned_to: null, version: 1, created_at: t, updated_at: t, submitted_at: null, decided_at: null, closed_at: null };
  load().apps.push(app);
  logEvent(app, "CREATED", "Создан черновик заявки", { type: "CLIENT", id: user.id, name: user.full_name }, {}, true, null, "DRAFT");
  return app;
}

// ------------------------------------------------------------------ маршруты

const TOKEN_PREFIX = "demo:";
interface Req { method: string; path: string; query: URLSearchParams; body: Any; form?: FormData; user: Any }
type Handler = (req: Req, m: RegExpMatchArray) => Any | Promise<Any>;
const routes: [string, RegExp, Handler, string?][] = [];
const route = (method: string, pattern: string, handler: Handler, role?: string) =>
  routes.push([method, new RegExp("^" + pattern.replace(/\{(\w+)\}/g, "([^/]+)") + "$"), handler, role]);

const userOut = (u: Any) => ({ id: u.id, email: u.email, full_name: u.full_name, position: u.position, role: u.role, company: u.company_id ? companyOf(u.company_id) : null });
const clientApp = (req: Req, id: string) => {
  const app = load().apps.find((a) => a.id === id);
  if (!app || app.company_id !== req.user.company_id) fail(404, "Заявка не найдена");
  return app;
};
const anyApp = (id: string) => load().apps.find((a) => a.id === id) || fail(404, "Заявка не найдена");
const clientActor = (u: Any): Actor => ({ type: "CLIENT", id: u.id, name: u.full_name });
const empActor = (u: Any): Actor => ({ type: "EMPLOYEE", id: u.id, name: `${u.full_name} (${u.position || u.role})` });
const mergeForm = (app: Any, fd: Any, consents: Any) => {
  if (fd) app.form_data = { ...app.form_data, ...fd };
  if (consents) app.consents = { ...consents, given_at: now().slice(0, 10) };
};

// auth
route("POST", "/auth/login", (req) => {
  const acc = DEMO_ACCOUNTS.find((a) => a.email === String(req.body?.email || "").toLowerCase());
  const reg = load().users.find((u) => u.email === String(req.body?.email || "").toLowerCase() && u.password);
  const user = load().users.find((u) => u.email === String(req.body?.email || "").toLowerCase());
  const ok = user && ((acc && acc.password === req.body?.password) || (reg && reg.password === req.body?.password) || (!acc && !reg && req.body?.password === "Demo123!"));
  if (!ok) fail(401, "Неверный e-mail или пароль");
  return { access_token: TOKEN_PREFIX + user.id, token_type: "bearer", user: userOut(user) };
});
route("POST", "/auth/register", (req) => {
  const { email, password, full_name, inn } = req.body || {};
  if (!isValidInn(String(inn || ""))) fail(422, [{ loc: ["body", "inn"], msg: "Некорректный ИНН (проверьте контрольную сумму)" }]);
  if (!password || password.length < 8) fail(422, [{ loc: ["body", "password"], msg: "Минимум 8 символов" }]);
  if (load().users.some((u) => u.email === email.toLowerCase())) fail(409, "Пользователь с таким e-mail уже зарегистрирован");
  let c = load().companies.find((x) => x.inn === inn);
  if (!c) {
    c = companyFromEgrul(inn);
    load().companies.push(c);
  }
  const u = { id: uid(), email: email.toLowerCase(), password, full_name, position: "Генеральный директор", role: "CLIENT", company_id: c.id };
  load().users.push(u);
  return { access_token: TOKEN_PREFIX + u.id, token_type: "bearer", user: userOut(u) };
});
route("GET", "/auth/me", (req) => userOut(req.user), "ANY");
route("GET", "/auth/demo-accounts", () => DEMO_ACCOUNTS);

// catalog
route("GET", "/products", () => load().products.filter((p) => p.is_active).sort((a, b) => a.sort_order - b.sort_order).map(productOut));
route("POST", "/products/recommend", (req) => {
  let { purpose = null, amount = null, term_months = null, has_collateral = false } = req.body || {};
  let parsed = null;
  if (req.body?.text) {
    parsed = parseNeed(req.body.text);
    purpose = purpose || parsed.purpose;
    amount = amount || parsed.amount;
    term_months = term_months || parsed.term_months;
    has_collateral = has_collateral || parsed.has_collateral;
  }
  const company = req.user.company_id ? companyOf(req.user.company_id) : null;
  const isClient = company ? !!external.accounts(company.inn).is_client : false;
  return { engine: "rules", parsed, request: { purpose, amount, term_months, has_collateral }, recommendations: recommend(company, purpose, amount, term_months, has_collateral, isClient) };
}, "ANY");
route("POST", "/products/calculate", (req) => {
  const p = productOf(req.body.product_code) || fail(404, "Продукт не найден");
  const rate = rateFor(terms(p), "A", false, KEY_RATE);
  const pay = annuity(req.body.amount, rate, req.body.term_months);
  const warnings = [];
  if (!(p.min_amount <= req.body.amount && req.body.amount <= p.max_amount)) warnings.push(`Сумма для продукта: ${fmt(p.min_amount)}–${fmt(p.max_amount)} ₽`);
  if (!(p.min_term <= req.body.term_months && req.body.term_months <= p.max_term)) warnings.push(`Срок для продукта: ${p.min_term}–${p.max_term} мес.`);
  return { rate_from: rate, monthly_payment: r2(pay), total_payment: r2(pay * req.body.term_months), overpayment: r2(pay * req.body.term_months - req.body.amount), warnings };
});
route("GET", "/companies/me/prefill", (req) => {
  const inn = companyOf(req.user.company_id).inn;
  const fns = external.fns(inn);
  return { sources: ["egrul", "fns", "accounts"], unavailable: [], egrul: external.egrul(inn), fns, accounts: external.accounts(inn),
    financials: { revenue_last_year: fns.revenue_last_year, expenses_last_year: fns.expenses_last_year, employees: fns.avg_employees, source: `ФНС «Прозрачный бизнес», отчётность за ${fns.year}` } };
}, "CLIENT");

// applications (client)
route("GET", "/applications", (req) => load().apps.filter((a) => a.company_id === req.user.company_id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(toShort), "CLIENT");
route("POST", "/applications", (req) => {
  if (!productOf(req.body?.product_code)) fail(422, "Неизвестный продукт");
  return toFull(createApp(req.user, req.body), false);
}, "CLIENT");
route("GET", "/applications/{id}", (req, m) => toFull(clientApp(req, m[1]), false), "CLIENT");
route("PATCH", "/applications/{id}", (req, m) => {
  const app = clientApp(req, m[1]);
  if (!["DRAFT", "INFO_REQUESTED"].includes(app.status)) fail(409, "Заявку можно изменять только в статусе черновика или при запросе информации");
  if (app.status === "DRAFT") for (const k of ["product_code", "amount", "term_months", "purpose", "purpose_comment"]) if (req.body?.[k] !== undefined) app[k] = req.body[k];
  mergeForm(app, req.body?.form_data, req.body?.consents);
  app.updated_at = now();
  return toFull(app, false);
}, "CLIENT");
route("POST", "/applications/{id}/submit", (req, m) => {
  const app = clientApp(req, m[1]);
  if (app.status !== "DRAFT") return toFull(app, false);
  const problems = [];
  if (!app.consents?.bki || !app.consents?.personal_data) problems.push("Нужны согласия на запрос в БКИ и обработку данных");
  if (!app.form_data?.financials?.revenue_last_year) problems.push("Укажите выручку за последний год");
  if (!app.form_data?.company_confirmed) problems.push("Подтвердите данные компании");
  if (problems.length) fail(422, { message: "Заявка заполнена не полностью", problems });
  transition(app, "SUBMITTED", clientActor(req.user), "Заявка отправлена в банк");
  return toFull(app, false);
}, "CLIENT");
route("POST", "/applications/{id}/documents", async (req, m) => {
  const app = clientApp(req, m[1]);
  if (!["DRAFT", "INFO_REQUESTED"].includes(app.status)) fail(409, "Документы можно добавлять в черновик или по запросу банка");
  const docType = String(req.form?.get("doc_type") || "");
  const file = req.form?.get("file") as File | null;
  if (!file) fail(422, "Нет файла");
  if (!/\.(pdf|png|jpe?g|csv|txt)$/i.test(file!.name)) fail(415, "Допустимые форматы: PDF, PNG, JPG, CSV, TXT");
  if (file!.size > 5 * 1024 * 1024) fail(413, "Файл больше 5 МБ");
  const parsed = docType === "BANK_STATEMENT" && /\.(csv|txt)$/i.test(file!.name) ? parseBankStatement(await file!.text()) : {};
  const doc = { id: uid(), application_id: app.id, doc_type: docType, filename: file!.name, content_type: file!.type || "application/octet-stream", size: file!.size, sha256: "", parsed, created_at: now() };
  load().docs.push(doc);
  let msg = `Загружен документ «${file!.name}»`;
  if ((parsed as Any).ok) msg += `: распознано ${(parsed as Any).operations} операций за ${(parsed as Any).months} мес.`;
  logEvent(app, "DOCUMENT_UPLOADED", msg, clientActor(req.user), { doc_type: docType });
  return doc;
}, "CLIENT");
route("POST", "/applications/{id}/info-response", (req, m) => {
  const app = clientApp(req, m[1]);
  if (app.status !== "INFO_REQUESTED") fail(409, "Банк не запрашивал дополнительную информацию");
  mergeForm(app, req.body?.form_data, req.body?.consents);
  const have = docTypes(app);
  const missing = (app.info_request.items || []).filter((i: Any) => i.type === "document" && i.doc_type && !have.has(i.doc_type)).map((i: Any) => i.text);
  if (missing.length && !req.body?.comment) fail(422, { message: "Загрузите запрошенные документы или оставьте комментарий", problems: missing });
  app.info_request = { ...app.info_request, response: { comment: req.body?.comment, at: now().slice(0, 10) } };
  transition(app, "SUBMITTED", clientActor(req.user), "Информация предоставлена, заявка возвращена на рассмотрение");
  return toFull(app, false);
}, "CLIENT");
route("POST", "/applications/{id}/accept-offer", (req, m) => {
  const app = clientApp(req, m[1]);
  if (!["APPROVED", "COUNTER_OFFER"].includes(app.status)) fail(409, "Нет активного предложения");
  const o = app.offer.options?.[req.body?.option_index] || fail(422, "Неверный вариант предложения");
  app.offer.selected_index = req.body.option_index;
  transition(app, "OFFER_ACCEPTED", clientActor(req.user), `Предложение принято: ${fmt(o.amount)} ₽ на ${o.term_months} мес. под ${o.rate}%`);
  return toFull(app, false);
}, "CLIENT");
route("POST", "/applications/{id}/sign", (req, m) => {
  const app = clientApp(req, m[1]);
  if (app.status !== "SIGNING") fail(409, "Договор не ожидает подписания");
  const attempts = app.loan.sign_attempts || 0;
  if (attempts >= 5) fail(429, "Превышено число попыток. Отмените заявку и создайте новую.");
  if (req.body?.code !== app.sign_code) {
    app.loan.sign_attempts = attempts + 1;
    fail(422, `Неверный код. Осталось попыток: ${4 - attempts}`);
  }
  app.loan = { ...app.loan, signed_by: req.user.full_name, signed_at: now().slice(0, 10) };
  transition(app, "SIGNED", clientActor(req.user), "Договор подписан простой электронной подписью");
  return toFull(app, false);
}, "CLIENT");
route("POST", "/applications/{id}/cancel", (req, m) => {
  const app = clientApp(req, m[1]);
  if (!CLIENT_CANCELLABLE.has(app.status)) fail(409, "Заявку уже нельзя отменить");
  transition(app, "CANCELLED", clientActor(req.user), "Заявка отозвана клиентом" + (req.body?.reason ? `: ${req.body.reason}` : ""));
  return toFull(app, false);
}, "CLIENT");

// engagement
route("GET", "/notifications", (req) => load().notifs.filter((n) => n.company_id === req.user.company_id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50), "CLIENT");
route("POST", "/notifications/read-all", (req) => {
  load().notifs.filter((n) => n.company_id === req.user.company_id).forEach((n) => (n.is_read = true));
}, "CLIENT");
route("GET", "/news/feed", (req) => rankFeed(companyOf(req.user.company_id), req.user.id), "CLIENT");
route("POST", "/news/{id}/interact", (req, m) => {
  load().interactions.push({ id: uid(), user_id: req.user.id, news_id: m[1], action: req.body?.action, created_at: now() });
}, "CLIENT");
route("POST", "/assistant/chat", (req) => {
  const app = req.body?.application_id && req.user.role === "CLIENT" ? clientApp(req, req.body.application_id) : null;
  return chat(req.user.company_id ? companyOf(req.user.company_id) : null, String(req.body?.message || ""), app);
}, "ANY");

// back office
route("GET", "/bank/applications", (req) => {
  const st = req.query.get("status"), q = (req.query.get("q") || "").toLowerCase(), product = req.query.get("product");
  return load().apps.filter((a) => a.status !== "DRAFT")
    .filter((a) => !st || st.split(",").includes(a.status))
    .filter((a) => !product || a.product_code === product)
    .filter((a) => {
      if (!q) return true;
      const c = companyOf(a.company_id);
      return a.number.toLowerCase().includes(q) || c.inn.includes(q) || c.name.toLowerCase().includes(q);
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(toShort);
}, "EMPLOYEE");
route("GET", "/bank/applications/{id}", (_req, m) => toFull(anyApp(m[1]), true), "EMPLOYEE");
route("POST", "/bank/applications/{id}/assign", (req, m) => {
  const app = anyApp(m[1]);
  if (!["MANUAL_REVIEW", "COMMITTEE_REVIEW"].includes(app.status)) fail(409, "Заявка не находится на ручном рассмотрении");
  app.assigned_to = req.user.id;
  logEvent(app, "ASSIGNED", `Заявку взял в работу: ${req.user.full_name}`, empActor(req.user), {}, false);
  return toFull(app, true);
}, "EMPLOYEE");
route("GET", "/bank/applications/{id}/ai-summary", (_req, m) => analystSummary(anyApp(m[1])), "EMPLOYEE");
route("POST", "/bank/applications/{id}/what-if", (req, m) => {
  const app = anyApp(m[1]);
  if (!app.enrichment?.fetched_at) fail(409, "Данные из источников ещё не получены");
  const p = req.query.get("product_code") ? productOf(req.query.get("product_code")!) : undefined;
  const res = runDecision(app, Number(req.query.get("amount")), Number(req.query.get("term_months")), p);
  return { score: res.score, grade: res.grade, affordability: res.affordability, decision: res.decision };
}, "EMPLOYEE");
route("POST", "/bank/applications/{id}/decision", (req, m) => {
  const app = anyApp(m[1]);
  const u = req.user, b = req.body || {}, actor = empActor(u);
  if (app.status === "COMMITTEE_REVIEW" && !["RISK_MANAGER", "ADMIN"].includes(u.role)) fail(403, "Решение на этапе согласования принимает риск-менеджер");
  if (!["MANUAL_REVIEW", "COMMITTEE_REVIEW"].includes(app.status)) fail(409, `Решение невозможно в статусе ${app.status}`);
  if (!b.comment || b.comment.length < 3) fail(422, "Укажите комментарий");
  const sc = app.scoring || {};
  const rec = sc.decision?.recommended_offer || {};
  const product = b.product_code ? productOf(b.product_code) : productOf(app.product_code);
  const amount = b.amount || rec.amount || app.amount, term = b.term_months || rec.term_months || app.term_months;
  const rate = b.rate || rec.rate || sc.affordability?.rate || KEY_RATE + product.margin;
  if (b.action === "APPROVE" || b.action === "COUNTER_OFFER") {
    if (!(product.min_amount <= amount && amount <= product.max_amount && product.min_term <= term && term <= product.max_term)) fail(422, "Условия вне параметров продукта");
    if (amount > COMMITTEE_LIMIT && app.status === "MANUAL_REVIEW" && u.role === "ANALYST") {
      app.decision = { ...app.decision, proposal: { action: b.action, amount, term_months: term, rate, product_code: product.code, by: u.full_name, comment: b.comment } };
      transition(app, "COMMITTEE_REVIEW", actor, "Решение согласуется с риск-менеджером (принцип «четырёх глаз»)");
    } else {
      const offer = makeOffer(terms(product), amount, term, rate, b.action === "APPROVE" ? "FULL" : "COUNTER", "Условия, согласованные специалистом банка");
      const options = [offer];
      if (b.action === "COUNTER_OFFER") options.push(...(sc.decision?.alternatives || []).filter((a: Any) => a.amount !== amount || a.term_months !== term).slice(0, 2));
      setOffer(app, options);
      app.decision = { ...app.decision, outcome: b.action, by: u.full_name, role: u.role, reasons: [b.comment], at: now() };
      transition(app, b.action === "APPROVE" ? "APPROVED" : "COUNTER_OFFER", actor,
        b.action === "APPROVE" ? "Кредит одобрен. Ознакомьтесь с условиями предложения." : "Банк готов выдать кредит на скорректированных условиях. Выберите вариант.");
    }
  } else if (b.action === "REJECT") {
    app.decision = { ...app.decision, outcome: "REJECT", by: u.full_name, reasons: [b.comment], tips: sc.decision?.improvement_tips || [], at: now() };
    transition(app, "REJECTED", actor, "Банк не может выдать кредит. " + b.comment);
  } else if (b.action === "REQUEST_INFO") {
    const items = [...(b.info_items || []).map((t: string) => ({ code: "ANALYST", type: "field", text: t })),
      ...(b.request_doc_types || []).map((d: string) => ({ code: `DOC_${d}`, type: "document", doc_type: d, text: `Загрузите: ${DOC_LABELS[d]}` }))];
    if (!items.length) fail(422, "Укажите, что запросить у клиента");
    app.info_request = { items, message: b.comment, requested_at: now(), by: u.full_name, response: null };
    app.info_rounds++;
    transition(app, "INFO_REQUESTED", actor, "Специалист банка просит уточнить: " + items.map((i: Any) => i.text).join("; "));
  } else if (b.action === "TO_COMMITTEE") transition(app, "COMMITTEE_REVIEW", actor, "Заявка передана на согласование риск-менеджеру");
  else if (b.action === "RETURN_TO_ANALYST") transition(app, "MANUAL_REVIEW", actor, "Заявка возвращена специалисту для доработки");
  logEvent(app, "EMPLOYEE_DECISION", `${b.action}: ${b.comment}`, actor, { action: b.action, amount, term, rate }, false);
  return toFull(app, true);
}, "EMPLOYEE");
route("GET", "/bank/dashboard", () => {
  const apps = load().apps;
  const byStatus: Record<string, number> = {};
  apps.forEach((a) => (byStatus[a.status] = (byStatus[a.status] || 0) + 1));
  const decided = apps.filter((a) => a.decided_at);
  const auto = decided.filter((a) => a.decision?.by === "SYSTEM").length;
  const okSt = new Set(["APPROVED", "COUNTER_OFFER", "OFFER_ACCEPTED", "SIGNING", "SIGNED", "DISBURSED"]);
  const approved = decided.filter((a) => okSt.has(a.status) || (a.status === "CANCELLED" && a.offer?.options)).length;
  const times = decided.filter((a) => a.submitted_at).map((a) => (new Date(a.decided_at).getTime() - new Date(a.submitted_at).getTime()) / 60000);
  const sum = (...s: string[]) => s.reduce((x, k) => x + (byStatus[k] || 0), 0);
  const submitted = apps.filter((a) => a.submitted_at).length;
  return {
    by_status: Object.entries(byStatus).map(([status, count]) => ({ status, label: STATUS_INFO[status].label, count })),
    total_submitted: submitted, decided: decided.length,
    auto_decision_rate: decided.length ? Math.round((auto / decided.length) * 1000) / 1000 : 0,
    approval_rate: decided.length ? Math.round((approved / decided.length) * 1000) / 1000 : 0,
    avg_minutes_to_decision: times.length ? Math.round((times.reduce((x, y) => x + y, 0) / times.length) * 10) / 10 : null,
    manual_queue: sum("MANUAL_REVIEW", "COMMITTEE_REVIEW"),
    disbursed_amount: apps.filter((a) => a.status === "DISBURSED").reduce((x, a) => x + a.amount, 0),
    funnel: { SUBMITTED: submitted, DECIDED: decided.length, OFFER_ACCEPTED: sum("OFFER_ACCEPTED", "SIGNING", "SIGNED", "DISBURSED"), SIGNED: sum("SIGNED", "DISBURSED"), DISBURSED: sum("DISBURSED") },
  };
}, "EMPLOYEE");
route("GET", "/bank/events", (req) => {
  const limit = Number(req.query.get("limit") || 30);
  return [...load().events].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map((e) => ({
    at: e.created_at, number: anyApp(e.application_id).number, application_id: e.application_id, type: e.event_type, to_status: e.to_status, actor: e.actor_name, message: e.message,
  }));
}, "EMPLOYEE");
route("GET", "/bank/companies", () => [...load().companies].sort((a, b) => a.name.localeCompare(b.name)), "EMPLOYEE");
route("GET", "/bank/news", () => [...load().news].sort((a, b) => b.published_at.localeCompare(a.published_at)), "EMPLOYEE");
route("POST", "/bank/news", (req) => {
  if (req.user.role !== "ADMIN") fail(403, "Недостаточно прав");
  const n = { id: uid(), body: "", source: "Публикация администратора", cta_label: null, cta_link: null, ...req.body, published_at: now(), is_active: true };
  load().news.push(n);
  return n;
}, "EMPLOYEE");
route("DELETE", "/bank/news/{id}", (req, m) => {
  if (req.user.role !== "ADMIN") fail(403, "Недостаточно прав");
  const n = load().news.find((x) => x.id === m[1]);
  if (n) n.is_active = false;
}, "EMPLOYEE");
route("GET", "/bank/news/preview", (req) => rankFeed(companyOf(req.query.get("company_id")!) || fail(404, "Компания не найдена"), null), "EMPLOYEE");

// ------------------------------------------------------------------ точка входа

export async function demoApi(method: string, fullPath: string, token: string | null, body: unknown, form?: FormData): Promise<{ status: number; data: unknown }> {
  const [path, qs] = fullPath.split("?");
  await new Promise((r) => setTimeout(r, 80)); // имитация сетевой задержки
  try {
    load();
    processDue();
    const user = token?.startsWith(TOKEN_PREFIX) ? load().users.find((u) => u.id === token.slice(TOKEN_PREFIX.length)) : null;
    for (const [m, rx, handler, role] of routes) {
      if (m !== method) continue;
      const match = path.match(rx);
      if (!match) continue;
      if (role) {
        if (!user) fail(401, "Требуется авторизация");
        if (role === "CLIENT" && user.role !== "CLIENT") fail(403, "Недостаточно прав");
        if (role === "EMPLOYEE" && user.role === "CLIENT") fail(403, "Недостаточно прав");
      }
      const data = await handler({ method, path, query: new URLSearchParams(qs || ""), body: body ?? {}, form, user }, match);
      save();
      return { status: data === undefined ? 204 : 200, data };
    }
    fail(404, "Not Found");
  } catch (e) {
    save();
    if (e instanceof HttpError) return { status: e.status, data: { detail: e.detail } };
    console.error(e);
    return { status: 500, data: { detail: "Ошибка демо-режима: " + (e as Error).message } };
  }
  return { status: 404, data: { detail: "Not Found" } };
}

export function demoDocument(appId: string, docId: string): Blob | null {
  const d = load().docs.find((x) => x.application_id === appId && x.id === docId);
  if (!d) return null;
  return new Blob([d.content || `Демо-версия: содержимое файла «${d.filename}» не сохраняется в браузере.`], { type: d.content ? "text/html" : "text/plain" });
}
