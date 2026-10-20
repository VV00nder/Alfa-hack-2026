import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Card, ErrorBox, Loading, StatusBadge, Stepper, Timeline } from "../../components/ui";
import { api, ApiError, appPath, openDocument } from "../../lib/api";
import { d, DOC_LABELS, IN_PROGRESS, mln, months, PURPOSES, rub } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import type { Application, Factor } from "../../lib/types";

const CHECKS: [string, string[]][] = [
  ["Проверка полноты и корректности данных", ["VALIDATION"]],
  ["Сведения ЕГРЮЛ и ФНС «Прозрачный бизнес»", ["ENRICHMENT"]],
  ["Кредитная история в БКИ и антифрод-проверка", ["ENRICHMENT"]],
  ["Оценка риска и расчёт условий", ["SCORING"]],
];
const ORDER = ["SUBMITTED", "VALIDATION", "ENRICHMENT", "SCORING"];

function Progress({ status }: { status: string }) {
  const cur = ORDER.indexOf(status);
  return (
    <div className="stack">
      {CHECKS.map(([label, st]) => {
        const idx = ORDER.indexOf(st[0]);
        const state = cur > idx ? "done" : cur === idx ? "run" : "wait";
        return (
          <div key={label} className="row" style={{ gap: 10 }}>
            {state === "done" ? <span style={{ color: "var(--ok)" }}>✓</span> : state === "run" ? <span className="spinner" /> : <span className="muted">○</span>}
            <span className={state === "wait" ? "muted" : ""}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function Factors({ factors }: { factors: Factor[] }) {
  return (
    <div>
      {factors.map((f) => (
        <div key={f.label} className="row between small" style={{ padding: "6px 0", borderBottom: "1px dashed var(--line)" }}>
          <span>
            {f.impact === "positive" ? "🟢" : f.impact === "negative" ? "🔴" : "⚪"} {f.label}
          </span>
          <span className="muted">{f.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function ApplicationPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: a, setData, reload } = useApi<Application>(`/applications/${id}`, (x) => (x && IN_PROGRESS.has(x.status) ? 1200 : 5000));
  const [sel, setSel] = useState(0);
  const [code, setCode] = useState("");
  const [comment, setComment] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);

  if (!a) return <Loading />;

  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setErr(null);
    try {
      setData(await api<Application>(`/applications/${a.id}/${path}`, { body }));
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (docType: string, file: File) => {
    const form = new FormData();
    form.append("doc_type", docType);
    form.append("file", file);
    try {
      await api(`/applications/${a.id}/documents`, { form });
      reload();
    } catch (e) {
      setErr(e as ApiError);
    }
  };

  const options = a.offer.options || [];
  const contract = a.documents.find((x) => x.doc_type === "CONTRACT");
  const factors = a.scoring?.factors || [];

  return (
    <div className="grid main-side">
      <div className="stack">
        <div className="card">
          <div className="row between">
            <div>
              <div className="small muted">Заявка {a.number} · {a.product.name} · {PURPOSES[a.purpose || ""] || ""}</div>
              <h1 style={{ margin: "4px 0" }}>{mln(a.amount)} на {months(a.term_months)}</h1>
            </div>
            <StatusBadge status={a.status} label={a.status_label} />
          </div>
          <Stepper stage={a.stage} status={a.status} />
          <div className="alert info" style={{ marginTop: 12 }}>{a.status_hint}</div>
        </div>

        <ErrorBox error={err?.message || null} problems={err?.problems} />

        {a.status === "DRAFT" && (
          <Card title="Черновик">
            <p>Заявка ещё не отправлена. Все введённые данные сохранены.</p>
            <Link className="btn" to={`/applications/new?id=${a.id}`}>Продолжить заполнение</Link>
          </Card>
        )}

        {ORDER.includes(a.status) && (
          <Card title="Проверяем заявку" extra={<span className="small muted">обычно меньше минуты</span>}>
            <Progress status={a.status} />
          </Card>
        )}

        {(a.status === "MANUAL_REVIEW" || a.status === "COMMITTEE_REVIEW") && (
          <Card title="Заявку изучает специалист">
            <p>Автоматическая проверка завершена, но для решения нужна экспертиза специалиста — это нормальная часть процесса для {a.amount > 10_000_000 ? "крупных сумм" : "ряда заявок"}.</p>
            <p className="muted small">Мы сообщим о решении здесь и в уведомлениях. Если банку понадобятся уточнения, вы увидите запрос в этой заявке.</p>
          </Card>
        )}

        {a.status === "INFO_REQUESTED" && (
          <Card title="Банку нужна дополнительная информация" className="accent">
            {a.info_request.message && <p>{a.info_request.message}</p>}
            <div className="stack">
              {(a.info_request.items || []).map((it, i) => {
                const have = it.doc_type ? a.documents.filter((x) => x.doc_type === it.doc_type) : [];
                return (
                  <div key={i} className="card flat" style={{ padding: 14 }}>
                    <div>{have.length ? "✅" : "📌"} {it.text}</div>
                    {it.type === "document" && it.doc_type && (
                      <div className="row" style={{ marginTop: 8 }}>
                        <label className="btn secondary sm">Загрузить файл<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.csv,.txt" onChange={(e) => e.target.files?.[0] && upload(it.doc_type!, e.target.files[0])} /></label>
                        {it.doc_type === "BANK_STATEMENT" && <a className="small" href={appPath("/samples/bank_statement_sample.csv")} download>пример CSV</a>}
                        {have.map((x) => (
                          <span key={x.id} className="small">📄 {x.filename}{x.parsed?.ok ? ` · ${x.parsed.months} мес., ${rub(x.parsed.avg_monthly_inflow)}/мес` : ""}</span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <label className="field"><span>Комментарий для банка</span><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} /></label>
              <button className="btn" disabled={busy} onClick={() => act("info-response", { comment: comment || null })}>Отправить и вернуть заявку в работу</button>
            </div>
          </Card>
        )}

        {(a.status === "APPROVED" || a.status === "COUNTER_OFFER") && (
          <Card title={a.status === "APPROVED" ? "🎉 Кредит одобрен" : "Банк предлагает другие условия"} className="accent">
            {a.status === "COUNTER_OFFER" && <p className="muted">Выдать кредит на запрошенных условиях не получится, но есть варианты, которые подходят вашему бизнесу:</p>}
            <div className={`grid ${options.length > 1 ? "g2" : ""}`}>
              {options.map((o, i) => (
                <div key={i} className={`offer ${sel === i ? "sel" : ""}`} onClick={() => setSel(i)}>
                  <div className="row between">
                    <span className="small muted">{o.product_name}</span>
                    <input type="radio" checked={sel === i} readOnly />
                  </div>
                  <div className="big num">{rub(o.amount)}</div>
                  <div className="small">на {months(o.term_months)} под <b>{o.rate}%</b></div>
                  <div style={{ marginTop: 8 }}>Платёж <b className="num">{rub(o.monthly_payment)}</b> в месяц</div>
                  <div className="small muted">Переплата {rub(o.overpayment)}</div>
                  <div className="small" style={{ marginTop: 8, color: "var(--info)" }}>{o.note}</div>
                </div>
              ))}
            </div>
            {a.offer.conditions && (
              <ul className="small" style={{ paddingLeft: 18 }}>
                {a.offer.conditions.map((c) => <li key={c}>{c}</li>)}
              </ul>
            )}
            <div className="small muted">Предложение действует до {d(a.offer.valid_until)}</div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" disabled={busy} onClick={() => act("accept-offer", { option_index: sel })}>Принять и перейти к договору</button>
              <button className="btn secondary" disabled={busy} onClick={() => confirm("Отказаться от предложения? Заявка будет закрыта.") && act("cancel", { reason: "Отказ от предложения" })}>Отказаться</button>
            </div>
          </Card>
        )}

        {a.status === "SIGNING" && (
          <Card title="Подписание договора" className="accent">
            <p>Проверьте договор и подпишите его кодом простой электронной подписи. Код — в уведомлениях 🔔 вверху страницы.</p>
            {contract && <button className="btn secondary" onClick={() => openDocument(a.id, contract.id)}>📄 Открыть договор {a.loan.contract_number}</button>}
            <div className="row" style={{ marginTop: 12 }}>
              <input style={{ maxWidth: 180, letterSpacing: 4, fontSize: 18 }} inputMode="numeric" maxLength={6} placeholder="______" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              <button className="btn" disabled={busy || code.length !== 6} onClick={() => act("sign", { code })}>Подписать</button>
            </div>
          </Card>
        )}

        {a.status === "DISBURSED" && (
          <Card title="✅ Деньги на счёте">
            <div className="kv">
              <div>Сумма</div><div><b>{rub(a.loan.amount)}</b></div>
              <div>Договор</div><div>{a.loan.contract_number}</div>
              <div>Счёт зачисления</div><div className="mono">{a.loan.account}</div>
              <div>Ставка / срок</div><div>{a.loan.rate}% · {months(a.loan.term_months || 0)}</div>
              <div>Ежемесячный платёж</div><div><b>{rub(a.loan.monthly_payment)}</b></div>
            </div>
            <button className="btn secondary sm" style={{ marginTop: 12 }} onClick={() => setShowSchedule(!showSchedule)}>{showSchedule ? "Скрыть" : "Показать"} график платежей</button>
            {showSchedule && (
              <div className="table-wrap" style={{ marginTop: 12, maxHeight: 360, overflow: "auto" }}>
                <table className="small">
                  <thead><tr><th>№</th><th>Дата</th><th>Платёж</th><th>Основной долг</th><th>Проценты</th><th>Остаток</th></tr></thead>
                  <tbody>
                    {a.loan.schedule?.map((r) => (
                      <tr key={r.n}><td>{r.n}</td><td>{d(r.date)}</td><td className="num">{rub(r.payment, 2)}</td><td className="num">{rub(r.principal, 2)}</td><td className="num">{rub(r.interest, 2)}</td><td className="num">{rub(r.balance, 2)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {a.status === "REJECTED" && (
          <Card title="Почему банк не может выдать кредит">
            <ul>{(a.decision.reasons || []).map((r) => <li key={r}>{r}</li>)}</ul>
            {(a.decision.tips || []).length > 0 && (
              <>
                <h3>Что можно сделать</h3>
                <ul>{a.decision.tips!.map((t) => <li key={t}>{t}</li>)}</ul>
              </>
            )}
            <button className="btn secondary" onClick={() => nav("/products")}>Подобрать другой продукт</button>
          </Card>
        )}

        {factors.length > 0 && !["DRAFT"].includes(a.status) && (
          <Card title="Что повлияло на решение" extra={<span className="small muted">объяснение модели</span>}>
            <Factors factors={factors} />
            {a.scoring?.affordability && (
              <p className="small muted" style={{ marginTop: 10 }}>
                Денежный поток бизнеса ≈ {rub(a.scoring.affordability.monthly_cash_flow)}/мес. Допустимый платёж по новому кредиту — до {rub(a.scoring.affordability.max_payment)}/мес.
              </p>
            )}
          </Card>
        )}
      </div>

      <div className="stack">
        <Card title="История заявки">
          <Timeline events={a.events} />
        </Card>
        {a.documents.length > 0 && (
          <Card title="Документы">
            {a.documents.map((x) => (
              <div key={x.id} className="row between small" style={{ padding: "4px 0" }}>
                <span>📄 {DOC_LABELS[x.doc_type]}: {x.filename}</span>
                {x.doc_type === "CONTRACT" && <button className="btn ghost sm" onClick={() => openDocument(a.id, x.id)}>Открыть</button>}
              </div>
            ))}
          </Card>
        )}
        {!["REJECTED", "CANCELLED", "DISBURSED", "SIGNED"].includes(a.status) && (
          <button className="btn ghost" onClick={() => confirm("Отозвать заявку?") && act("cancel", { reason: "Отозвана клиентом" })}>Отозвать заявку</button>
        )}
      </div>
    </div>
  );
}
