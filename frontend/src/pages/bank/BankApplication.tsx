import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Card, ErrorBox, Loading, MoneyInput, StatusBadge, Stepper, Timeline } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { d, DOC_LABELS, IN_PROGRESS, mln, months, PURPOSES, rub } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import type { Application, OfferOption, Product } from "../../lib/types";

const OUTCOME: Record<string, [string, string]> = {
  APPROVE: ["Одобрить", "ok"], COUNTER_OFFER: ["Встречное предложение", "warn"], MANUAL_REVIEW: ["Ручное рассмотрение", "info"], REJECT: ["Отказ", "bad"],
};

function ScoreBlock({ a }: { a: Application }) {
  const s = a.scoring!;
  const max = Math.max(...s.factors.map((f) => Math.abs(f.points || 0)), 1);
  const af = s.affordability;
  return (
    <div className="stack">
      <div className="grid g4">
        <div className="card flat kpi"><div className="v">{s.grade}</div><div className="l">рейтинг · {s.score} баллов</div></div>
        <div className="card flat kpi"><div className="v">{((s.pd || 0) * 100).toFixed(1)}%</div><div className="l">вероятность дефолта (PD)</div></div>
        <div className="card flat kpi"><div className="v" style={{ color: af.dscr >= af.dscr_min ? "var(--ok)" : "var(--bad)" }}>{af.dscr}</div><div className="l">DSCR по запросу (мин. {af.dscr_min})</div></div>
        <div className="card flat kpi"><div className="v">{mln(af.max_amount_for_term)}</div><div className="l">макс. сумма на {a.term_months} мес.</div></div>
      </div>
      <div>
        <h3>Балльная карта <span className="small muted">{s.model_version} · база 520</span></h3>
        {s.factors.map((f) => (
          <div key={f.code} className="factor">
            <div>{f.label} <span className="muted small">— {f.value}</span></div>
            <div className="fbar">
              <i className={(f.points || 0) >= 0 ? "pos" : "neg"} style={{ width: `${(Math.abs(f.points || 0) / max) * 50}%` }} />
            </div>
            <div className="num" style={{ textAlign: "right", color: (f.points || 0) > 0 ? "var(--ok)" : (f.points || 0) < 0 ? "var(--bad)" : "inherit" }}>{(f.points || 0) > 0 ? "+" : ""}{f.points}</div>
          </div>
        ))}
      </div>
      <div className="grid g2">
        <div>
          <h3>Денежный поток</h3>
          <div className="kv small" style={{ gridTemplateColumns: "1fr auto" }}>
            <div>Денежный поток в месяц</div><div className="num">{rub(af.monthly_cash_flow)}</div>
            <div>Текущие платежи (БКИ/анкета)</div><div className="num">{rub(af.existing_payments)}</div>
            <div>Допустимый новый платёж</div><div className="num">{rub(af.max_payment)}</div>
            <div>Платёж по запросу</div><div className="num">{rub(af.requested_payment)}</div>
            <div>Ставка по модели</div><div>{af.rate}%</div>
          </div>
        </div>
        <div>
          <h3>Политика</h3>
          {(s.stop_factors || []).map((x) => <div key={x.code} className="alert bad small" style={{ marginBottom: 6 }}>⛔ {x.code}: {x.label}</div>)}
          {(s.manual_triggers || []).map((x, i) => <div key={i} className="alert warn small" style={{ marginBottom: 6 }}>✋ {x.code}: {x.label}</div>)}
          {(s.eligibility_issues || []).map((x) => <div key={x} className="alert warn small" style={{ marginBottom: 6 }}>{x}</div>)}
          {!s.stop_factors?.length && !s.manual_triggers?.length && <div className="alert ok small">Стоп-факторов и триггеров нет</div>}
        </div>
      </div>
    </div>
  );
}

function Sources({ a }: { a: Application }) {
  const e = a.enrichment || {};
  const eg = e.egrul || {}, fns = e.fns || {}, bki = e.bki || {}, acc = e.accounts || {}, af = e.antifraud || {};
  return (
    <div className="stack">
      {e.unavailable?.length > 0 && <div className="alert warn">Недоступные источники: {e.unavailable.join(", ")}</div>}
      <div className="grid g2">
        <div className="card flat">
          <h3>ЕГРЮЛ / ЕГРИП</h3>
          <div className="kv small" style={{ gridTemplateColumns: "130px 1fr" }}>
            <div>Статус</div><div>{eg.status}</div>
            <div>Регистрация</div><div>{d(eg.registration_date)}</div>
            <div>ОКВЭД</div><div>{eg.okved_main?.code} {eg.okved_main?.name}</div>
            <div>Руководитель</div><div>{eg.director?.name}</div>
            <div>Учредители</div><div>{(eg.founders || []).map((f: any) => `${f.name} ${f.share}%`).join("; ") || "—"}</div>
            <div>Адрес</div><div>{eg.address}</div>
          </div>
        </div>
        <div className="card flat">
          <h3>ФНС «Прозрачный бизнес» ({fns.year})</h3>
          <div className="kv small" style={{ gridTemplateColumns: "150px 1fr" }}>
            <div>Выручка</div><div className="num">{rub(fns.revenue_last_year)}</div>
            <div>Расходы</div><div className="num">{rub(fns.expenses_last_year)}</div>
            <div>Налоги уплачены</div><div className="num">{rub(fns.taxes_paid)}</div>
            <div>Недоимка</div><div className="num" style={{ color: fns.tax_arrears ? "var(--bad)" : undefined }}>{rub(fns.tax_arrears)}</div>
            <div>Режим / штат</div><div>{fns.tax_regime} · {fns.avg_employees} чел.</div>
            <div>Отметки</div><div>{Object.entries(fns.flags || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "нет"}</div>
          </div>
        </div>
        <div className="card flat">
          <h3>Бюро кредитных историй</h3>
          <div className="kv small" style={{ gridTemplateColumns: "170px 1fr" }}>
            <div>Скоринговый балл</div><div><b>{bki.score ?? "—"}</b></div>
            <div>Макс. просрочка 12 мес.</div><div>{bki.max_overdue_days_12m ?? 0} дн.</div>
            <div>Запросов за 30 дней</div><div>{bki.inquiries_30d}</div>
            <div>Закрытых кредитов</div><div>{bki.closed_loans}</div>
          </div>
          {(bki.active_loans || []).length > 0 && (
            <table className="small" style={{ marginTop: 8 }}>
              <thead><tr><th>Обязательство</th><th>Остаток</th><th>Платёж</th></tr></thead>
              <tbody>{bki.active_loans.map((l: any, i: number) => <tr key={i}><td>{l.type}</td><td className="num">{rub(l.balance)}</td><td className="num">{rub(l.monthly_payment)}</td></tr>)}</tbody>
            </table>
          )}
        </div>
        <div className="card flat">
          <h3>Счета в банке и антифрод</h3>
          <div className="kv small" style={{ gridTemplateColumns: "170px 1fr" }}>
            <div>Клиент банка</div><div>{acc.is_client ? `да, ${acc.account_months} мес.` : "нет"}</div>
            {acc.is_client && (<><div>Поступления в месяц</div><div className="num">{rub(acc.avg_monthly_inflow)}</div><div>Средний остаток</div><div className="num">{rub(acc.avg_balance)}</div></>)}
            <div>Антифрод</div><div><span className={`badge ${af.risk_level === "LOW" ? "ok" : af.risk_level === "MEDIUM" ? "warn" : "bad"}`}>{af.risk_level}</span> {(af.reasons || []).join("; ")}</div>
          </div>
        </div>
      </div>
      <div className="card flat">
        <h3>Документы клиента</h3>
        {a.documents.length === 0 ? <div className="small muted">Нет</div> : a.documents.map((x) => (
          <div key={x.id} className="small" style={{ padding: "4px 0" }}>
            📄 {DOC_LABELS[x.doc_type]}: {x.filename} · {Math.round(x.size / 1024)} КБ · <span className="mono">{x.content_type}</span>
            {x.parsed?.ok && <span style={{ color: "var(--ok)" }}> · выписка: {x.parsed.period}, поступления {rub(x.parsed.avg_monthly_inflow)}/мес</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function DecisionPanel({ a, products, onDone }: { a: Application; products: Product[]; onDone: (x: Application) => void }) {
  const { user } = useAuth();
  const rec = a.scoring?.decision?.recommended_offer as OfferOption | null | undefined;
  const [action, setAction] = useState("APPROVE");
  const [amount, setAmount] = useState(rec?.amount || a.amount);
  const [term, setTerm] = useState(rec?.term_months || a.term_months);
  const [rate, setRate] = useState(rec?.rate || a.scoring?.affordability.rate || 20);
  const [product, setProduct] = useState(a.product_code);
  const [comment, setComment] = useState("");
  const [items, setItems] = useState("");
  const [docs, setDocs] = useState<string[]>([]);
  const [whatIf, setWhatIf] = useState<{ grade: string; affordability: Record<string, number>; decision: { outcome: string } } | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const committee = a.status === "COMMITTEE_REVIEW";
  const canDecide = !committee || user!.role !== "ANALYST";

  useEffect(() => {
    if (!["APPROVE", "COUNTER_OFFER"].includes(action) || !a.enrichment) return;
    const t = window.setTimeout(() => {
      api<typeof whatIf>(`/bank/applications/${a.id}/what-if?amount=${amount}&term_months=${term}&product_code=${product}`, { method: "POST" })
        .then(setWhatIf).catch(() => setWhatIf(null));
    }, 400);
    return () => window.clearTimeout(t);
  }, [amount, term, product, action, a.id, a.enrichment]);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { action, comment };
      if (["APPROVE", "COUNTER_OFFER"].includes(action)) Object.assign(body, { amount, term_months: term, rate, product_code: product });
      if (action === "REQUEST_INFO") Object.assign(body, { info_items: items.split("\n").map((s) => s.trim()).filter(Boolean), request_doc_types: docs });
      onDone(await api<Application>(`/bank/applications/${a.id}/decision`, { body }));
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const actions: [string, string][] = committee
    ? [["APPROVE", "Согласовать"], ["COUNTER_OFFER", "Встречное предложение"], ["REJECT", "Отказать"], ["RETURN_TO_ANALYST", "Вернуть аналитику"]]
    : [["APPROVE", "Одобрить"], ["COUNTER_OFFER", "Встречное предложение"], ["REQUEST_INFO", "Запросить информацию"], ["REJECT", "Отказать"], ["TO_COMMITTEE", "На комитет"]];

  return (
    <Card title={committee ? "Согласование (4 глаза)" : "Решение специалиста"} className="accent">
      {committee && a.decision.proposal && (
        <div className="alert info small" style={{ marginBottom: 10 }}>
          Предложение аналитика ({String(a.decision.proposal.by)}): {String(a.decision.proposal.action)} — {rub(Number(a.decision.proposal.amount))} на {String(a.decision.proposal.term_months)} мес. под {String(a.decision.proposal.rate)}%. «{String(a.decision.proposal.comment)}»
        </div>
      )}
      {!canDecide ? <div className="alert warn">Решение на этапе согласования принимает риск-менеджер.</div> : (
        <div className="stack">
          <div className="tabs" style={{ flexWrap: "wrap" }}>
            {actions.map(([k, l]) => <button key={k} className={action === k ? "active" : ""} onClick={() => setAction(k)}>{l}</button>)}
          </div>
          {["APPROVE", "COUNTER_OFFER"].includes(action) && (
            <>
              <label className="field"><span>Продукт</span>
                <select value={product} onChange={(e) => setProduct(e.target.value)}>{products.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></label>
              <div className="grid g2">
                <label className="field"><span>Сумма</span><MoneyInput value={amount} onChange={setAmount} /></label>
                <label className="field"><span>Срок, мес.</span><input type="number" value={term} min={1} max={120} onChange={(e) => setTerm(+e.target.value)} /></label>
              </div>
              <label className="field"><span>Ставка, %</span><input type="number" step="0.25" value={rate} onChange={(e) => setRate(+e.target.value)} /></label>
              {whatIf && (
                <div className={`alert ${whatIf.affordability.dscr >= whatIf.affordability.dscr_min ? "ok" : "warn"} small`}>
                  What-if: DSCR {whatIf.affordability.dscr} · платёж {rub(whatIf.affordability.requested_payment)} · макс. сумма {mln(whatIf.affordability.max_amount_for_term)} · модель: {OUTCOME[whatIf.decision.outcome]?.[0]}
                </div>
              )}
              {amount > 15_000_000 && !committee && user!.role === "ANALYST" && <div className="alert info small">Сумма больше 15 млн ₽ — решение уйдёт на согласование риск-менеджеру.</div>}
            </>
          )}
          {action === "REQUEST_INFO" && (
            <>
              <label className="field"><span>Что уточнить (каждый пункт с новой строки)</span><textarea rows={3} value={items} onChange={(e) => setItems(e.target.value)} placeholder="Расшифровка дебиторской задолженности" /></label>
              <div className="stack small">
                {["FIN_STATEMENTS", "BANK_STATEMENT", "COLLATERAL_DOCS"].map((k) => (
                  <label key={k} className="check"><input type="checkbox" checked={docs.includes(k)} onChange={(e) => setDocs(e.target.checked ? [...docs, k] : docs.filter((x) => x !== k))} /> {DOC_LABELS[k]}</label>
                ))}
              </div>
            </>
          )}
          <label className="field"><span>Комментарий (обоснование, сохраняется в аудите)</span><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
          <ErrorBox error={err?.message || null} problems={err?.problems} />
          <button className="btn" disabled={busy || comment.trim().length < 3} onClick={submit}>Применить решение</button>
        </div>
      )}
    </Card>
  );
}

export default function BankApplication() {
  const { id } = useParams();
  const { data: a, setData } = useApi<Application>(`/bank/applications/${id}`, (x) => (x && IN_PROGRESS.has(x.status) ? 1500 : 6000));
  const products = useApi<Product[]>("/products");
  const [tab, setTab] = useState("score");
  const [summary, setSummary] = useState<{ summary: string; engine: string } | null>(null);

  useEffect(() => {
    if (a?.scoring?.score != null && !summary) api<{ summary: string; engine: string }>(`/bank/applications/${a.id}/ai-summary`).then(setSummary);
  }, [a?.scoring?.score, a?.id, summary]);

  if (!a || !products.data) return <Loading />;
  const dec = a.scoring?.decision;
  const fin = a.form_data.financials || {};
  const manual = a.status === "MANUAL_REVIEW" || a.status === "COMMITTEE_REVIEW";

  return (
    <div className="stack">
      <div className="card">
        <div className="row between">
          <div>
            <div className="small muted">{a.number} · {a.product.name} · {PURPOSES[a.purpose || ""]}{a.purpose_comment ? ` — ${a.purpose_comment}` : ""}</div>
            <h1 style={{ margin: "4px 0" }}>{a.company.name} · {mln(a.amount)} на {months(a.term_months)}</h1>
            <div className="small muted">ИНН {a.company.inn} · {a.company.okved} {a.company.okved_name} · {a.company.region}</div>
          </div>
          <div className="row">
            {manual && <button className="btn secondary sm" onClick={async () => setData(await api<Application>(`/bank/applications/${a.id}/assign`, { method: "POST" }))}>{a.assigned_to ? "Взять себе" : "Взять в работу"}</button>}
            <StatusBadge status={a.status} label={a.status_label} />
          </div>
        </div>
        <Stepper stage={a.stage} status={a.status} />
      </div>

      <div className="grid main-side">
        <div className="stack">
          {dec && (
            <div className={`alert ${OUTCOME[dec.outcome]?.[1] || "info"}`}>
              <b>Рекомендация системы: {OUTCOME[dec.outcome]?.[0]}</b>
              {dec.recommended_offer && <> — {rub(dec.recommended_offer.amount)} на {dec.recommended_offer.term_months} мес. под {dec.recommended_offer.rate}%</>}
              <div className="small">{dec.reasons.join(" · ")}</div>
            </div>
          )}
          {summary && (
            <Card title="🤖 Резюме для андеррайтера" extra={<span className="small muted">{summary.engine === "rules" ? "по данным заявки" : summary.engine}</span>}>
              <div className="small" style={{ whiteSpace: "pre-wrap" }}>{summary.summary}</div>
            </Card>
          )}
          <Card>
            <div className="tabs">
              {[["score", "Скоринг и политика"], ["sources", "Внешние источники"], ["form", "Анкета клиента"], ["history", "Аудит"]].map(([k, l]) => (
                <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>
            {tab === "score" && (a.scoring?.score != null ? <ScoreBlock a={a} /> : <div className="empty">Скоринг ещё не выполнен</div>)}
            {tab === "sources" && (a.enrichment?.fetched_at ? <Sources a={a} /> : <div className="empty">Данные ещё не запрошены</div>)}
            {tab === "form" && (
              <div className="kv">
                <div>Выручка (заявлено)</div><div>{rub(fin.revenue_last_year)}</div>
                <div>Расходы (заявлено)</div><div>{rub(fin.expenses_last_year)}</div>
                <div>Платежи по кредитам</div><div>{rub(fin.existing_monthly_payments)}</div>
                <div>Залог</div><div>{a.form_data.collateral?.type !== "NONE" ? `${a.form_data.collateral?.description || a.form_data.collateral?.type} · ${rub(a.form_data.collateral?.estimated_value)}` : "нет"}</div>
                <div>Поручительство собственника</div><div>{a.form_data.owner_guarantee ? "да" : "нет"}</div>
                <div>Контакт</div><div>{a.form_data.contact?.name} {a.form_data.contact?.position ? `(${a.form_data.contact.position})` : ""}</div>
                <div>Согласия</div><div>БКИ: {a.consents.bki ? "да" : "нет"}, ПДн: {a.consents.personal_data ? "да" : "нет"}</div>
                {a.info_request.response?.comment && (<><div>Ответ на запрос</div><div>{a.info_request.response.comment}</div></>)}
              </div>
            )}
            {tab === "history" && <Timeline events={a.events} showActor />}
          </Card>
        </div>

        <div className="stack">
          {manual ? <DecisionPanel key={a.status} a={a} products={products.data} onDone={setData} /> : (
            <Card title="Статус">
              <p>{a.status_hint}</p>
              {(a.offer.options || []).length > 0 && (
                <div className="small">
                  <b>Предложение клиенту:</b>
                  {a.offer.options!.map((o, i) => <div key={i}>{a.offer.selected_index === i ? "✅ " : "• "}{o.product_name}: {rub(o.amount)} / {o.term_months} мес. / {o.rate}%</div>)}
                </div>
              )}
              {a.decision.by && <div className="small muted" style={{ marginTop: 8 }}>Решение: {a.decision.by === "SYSTEM" ? "автоматически" : a.decision.by}</div>}
            </Card>
          )}
          <Card title="История"><Timeline events={a.events.slice(-8)} showActor /></Card>
        </div>
      </div>
    </div>
  );
}
