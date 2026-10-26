import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Card, ErrorBox, Loading, MoneyInput } from "../../components/ui";
import { api, ApiError, appPath } from "../../lib/api";
import { d, DOC_LABELS, mln, months, PURPOSES, rub } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import type { Application, Product } from "../../lib/types";

interface Prefill {
  egrul: Record<string, any> | null;
  fns: Record<string, any> | null;
  accounts: Record<string, any> | null;
  financials: { revenue_last_year?: number; expenses_last_year?: number; employees?: number; source?: string };
  unavailable: string[];
}

const STEPS = ["Параметры", "Компания", "Финансы", "Обеспечение", "Документы", "Отправка"];

export default function NewApplication() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const products = useApi<Product[]>("/products");
  const prefill = useApi<Prefill>("/companies/me/prefill");
  const [app, setApp] = useState<Application | null>(null);
  const [step, setStep] = useState(0);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [err, setErr] = useState<ApiError | null>(null);
  const [calc, setCalc] = useState<{ rate_from: number; monthly_payment: number; overpayment: number; warnings: string[] } | null>(null);
  const timer = useRef<number>();
  const created = useRef(false);

  // создаём черновик сразу или продолжаем существующий
  useEffect(() => {
    if (created.current) return;
    created.current = true;
    const id = params.get("id");
    if (id) {
      api<Application>(`/applications/${id}`).then(setApp);
      return;
    }
    api<Application>("/applications", {
      body: {
        product_code: params.get("product") || "EXPRESS",
        amount: Number(params.get("amount")) || 3_000_000,
        term_months: Number(params.get("term")) || 24,
        purpose: params.get("purpose") || "WORKING_CAPITAL",
      },
    }).then((a) => {
      setApp(a);
      window.history.replaceState(null, "", `/applications/new?id=${a.id}`);
    }).catch((e) => setErr(e));
  }, [params]);

  // предзаполнение финансов из ФНС, если клиент ещё ничего не вводил
  useEffect(() => {
    if (!app || !prefill.data || app.form_data.financials?.revenue_last_year) return;
    const f = prefill.data.financials;
    if (f.revenue_last_year) {
      patch({ form_data: { ...app.form_data, financials: { ...app.form_data.financials, revenue_last_year: f.revenue_last_year, expenses_last_year: f.expenses_last_year, employees: f.employees, existing_monthly_payments: 0 } } }, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.id, prefill.data]);

  const appRef = useRef<Application | null>(null);
  appRef.current = app;

  // автосохранение черновика с debounce: клиент может уйти и вернуться к заявке позже
  const patch = useCallback((changes: Partial<Application> & Record<string, unknown>, immediate = false) => {
    if (!appRef.current) return;
    const next = { ...appRef.current, ...changes } as Application;
    appRef.current = next;
    setApp(next);
    setSaved("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const cur = appRef.current!;
      api<Application>(`/applications/${cur.id}`, {
        method: "PATCH",
        body: {
          product_code: cur.product_code, amount: cur.amount, term_months: cur.term_months, purpose: cur.purpose,
          purpose_comment: cur.purpose_comment, form_data: cur.form_data, consents: cur.consents,
        },
      }).then(() => setSaved("saved")).catch((e) => setErr(e));
    }, immediate ? 0 : 600);
  }, []);

  useEffect(() => {
    if (!app) return;
    const t = window.setTimeout(() => {
      api<typeof calc>("/products/calculate", { body: { product_code: app.product_code, amount: app.amount, term_months: app.term_months } }).then(setCalc).catch(() => setCalc(null));
    }, 300);
    return () => window.clearTimeout(t);
  }, [app?.product_code, app?.amount, app?.term_months]);

  if (err && !app) return <ErrorBox error={err.message} />;
  if (!app || !products.data) return <Loading />;
  if (app.status !== "DRAFT") return <Navigate to={`/applications/${app.id}`} replace />;

  const product = products.data.find((p) => p.code === app.product_code)!;
  const fd = app.form_data;
  const fin = fd.financials || {};
  const col = fd.collateral || {};
  const pre = prefill.data;
  const eg = pre?.egrul || {};
  const setFin = (k: string, v: number) => patch({ form_data: { ...fd, financials: { ...fin, [k]: v } } });
  const setCol = (k: string, v: unknown) => patch({ form_data: { ...fd, collateral: { ...col, [k]: v } } });

  const upload = async (docType: string, file: File) => {
    const form = new FormData();
    form.append("doc_type", docType);
    form.append("file", file);
    try {
      await api(`/applications/${app.id}/documents`, { form });
      setApp(await api<Application>(`/applications/${app.id}`));
    } catch (e) {
      setErr(e as ApiError);
    }
  };

  const submit = async () => {
    setErr(null);
    window.clearTimeout(timer.current);
    try {
      await api(`/applications/${app.id}`, { method: "PATCH", body: { form_data: app.form_data, consents: app.consents, amount: app.amount, term_months: app.term_months, product_code: app.product_code, purpose: app.purpose, purpose_comment: app.purpose_comment } });
      await api(`/applications/${app.id}/submit`, { method: "POST" });
      nav(`/applications/${app.id}`);
    } catch (e) {
      setErr(e as ApiError);
    }
  };

  const canNext = [
    app.amount >= product.min_amount && app.amount <= product.max_amount && app.term_months >= product.min_term && app.term_months <= product.max_term,
    !!fd.company_confirmed,
    !!fin.revenue_last_year,
    (!product.collateral_required || !!col.estimated_value) && (!product.guarantee_required || !!fd.owner_guarantee),
    true,
    !!app.consents.bki && !!app.consents.personal_data,
  ];

  return (
    <div className="grid main-side">
      <div className="stack">
        <div className="row between">
          <div>
            <h1>Заявка на кредит</h1>
            <div className="small muted">Черновик {app.number} · данные сохраняются автоматически</div>
          </div>
          <span className="small muted">{saved === "saving" ? "Сохраняем…" : saved === "saved" ? "✓ Сохранено" : ""}</span>
        </div>
        <div className="wizard-steps">
          {STEPS.map((s, i) => (
            <button key={s} className={i === step ? "active" : i < step && canNext[i] ? "done" : ""} onClick={() => setStep(i)}>
              {i + 1}. {s}
            </button>
          ))}
        </div>

        <Card>
          {step === 0 && (
            <div className="stack">
              <label className="field">
                <span>Продукт</span>
                <select value={app.product_code} onChange={(e) => patch({ product_code: e.target.value })}>
                  {products.data.map((p) => <option key={p.code} value={p.code}>{p.name} — {p.tagline}</option>)}
                </select>
              </label>
              <div className="grid g2">
                <label className="field">
                  <span>Сумма, ₽</span>
                  <MoneyInput value={app.amount} onChange={(v) => patch({ amount: v })} />
                  <div className="hint">от {mln(product.min_amount)} до {mln(product.max_amount)}</div>
                </label>
                <label className="field">
                  <span>Срок: {months(app.term_months)}</span>
                  <input type="range" min={product.min_term} max={product.max_term} value={app.term_months} onChange={(e) => patch({ term_months: +e.target.value })} />
                  <div className="hint">от {product.min_term} до {product.max_term} мес.</div>
                </label>
              </div>
              <label className="field">
                <span>Цель кредита</span>
                <select value={app.purpose || ""} onChange={(e) => patch({ purpose: e.target.value })}>
                  {Object.entries(PURPOSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Коротко о цели (необязательно)</span>
                <input value={app.purpose_comment || ""} onChange={(e) => patch({ purpose_comment: e.target.value })} placeholder="Например: покупка второй ротационной печи" maxLength={1000} />
              </label>
            </div>
          )}

          {step === 1 && (
            <div className="stack">
              <div className="alert info">Мы уже получили сведения о компании из ЕГРЮЛ — проверьте их. Вводить ничего не нужно.</div>
              {!pre ? <Loading /> : (
                <div className="kv">
                  <div>Наименование</div><div>{eg.full_name}</div>
                  <div>ИНН / ОГРН</div><div className="mono">{eg.inn} / {eg.ogrn}</div>
                  <div>Статус</div><div>{eg.status === "ACTIVE" ? "Действующая" : eg.status}</div>
                  <div>Дата регистрации</div><div>{d(eg.registration_date)}</div>
                  <div>Основной ОКВЭД</div><div>{eg.okved_main?.code} — {eg.okved_main?.name}</div>
                  <div>Адрес</div><div>{eg.address}</div>
                  <div>Руководитель</div><div>{eg.director?.name}, {eg.director?.position}</div>
                  {eg.founders?.length > 0 && (<><div>Учредители</div><div>{eg.founders.map((f: any) => `${f.name} (${f.share}%)`).join(", ")}</div></>)}
                </div>
              )}
              <label className="check"><input type="checkbox" checked={!!fd.company_confirmed} onChange={(e) => patch({ form_data: { ...fd, company_confirmed: e.target.checked } })} /> Данные верны</label>
              <div className="grid g2">
                <label className="field"><span>Контактное лицо</span><input value={fd.contact?.name || ""} onChange={(e) => patch({ form_data: { ...fd, contact: { ...fd.contact, name: e.target.value } } })} /></label>
                <label className="field"><span>Должность</span><input value={fd.contact?.position || ""} onChange={(e) => patch({ form_data: { ...fd, contact: { ...fd.contact, position: e.target.value } } })} /></label>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="stack">
              {pre?.financials.source && <div className="alert ok">Цифры подставлены из открытых данных ФНС «Прозрачный бизнес». Исправьте, если за последние месяцы они изменились.</div>}
              <div className="grid g2">
                <label className="field"><span>Выручка за последний год, ₽</span><MoneyInput value={fin.revenue_last_year} onChange={(v) => setFin("revenue_last_year", v)} />
                  {pre?.financials.revenue_last_year ? <div className="prefilled">ФНС: {rub(pre.financials.revenue_last_year)}</div> : null}</label>
                <label className="field"><span>Расходы за год (без платежей по кредитам), ₽</span><MoneyInput value={fin.expenses_last_year} onChange={(v) => setFin("expenses_last_year", v)} />
                  {pre?.financials.expenses_last_year ? <div className="prefilled">ФНС: {rub(pre.financials.expenses_last_year)}</div> : null}</label>
                <label className="field"><span>Платежи по текущим кредитам и лизингу в месяц, ₽</span><MoneyInput value={fin.existing_monthly_payments} onChange={(v) => setFin("existing_monthly_payments", v)} placeholder="0" />
                  <div className="hint">Если не помните точно — не страшно: данные уточним в бюро кредитных историй</div></label>
                <label className="field"><span>Сотрудников</span><input type="number" min={0} value={fin.employees ?? ""} onChange={(e) => setFin("employees", +e.target.value)} /></label>
              </div>
              {pre?.accounts?.is_client && <div className="alert info">У вас есть счёт в банке: обороты {rub(pre.accounts.avg_monthly_inflow)} в месяц учтём автоматически.</div>}
            </div>
          )}

          {step === 3 && (
            <div className="stack">
              {!product.collateral_required && !product.guarantee_required && <div className="alert ok">Для «{product.name}» обеспечение не требуется. Если хотите, укажите залог — это может улучшить условия.</div>}
              {product.guarantee_required && (
                <label className="check"><input type="checkbox" checked={!!fd.owner_guarantee} onChange={(e) => patch({ form_data: { ...fd, owner_guarantee: e.target.checked } })} />
                  <span>Собственник бизнеса готов выступить поручителем <span className="muted small">(обязательно для продукта)</span></span></label>
              )}
              <div className="grid g2">
                <label className="field"><span>Залог {product.collateral_required && <b style={{ color: "var(--red)" }}>*</b>}</span>
                  <select value={col.type || "NONE"} onChange={(e) => setCol("type", e.target.value)}>
                    <option value="NONE">Без залога</option><option value="REAL_ESTATE">Недвижимость</option><option value="EQUIPMENT">Оборудование</option>
                    <option value="VEHICLE">Транспорт</option><option value="GOODS">Товары в обороте</option>
                  </select></label>
                <label className="field"><span>Оценочная стоимость, ₽</span><MoneyInput value={col.estimated_value} onChange={(v) => setCol("estimated_value", v)} /></label>
              </div>
              <label className="field"><span>Описание залога</span><input value={col.description || ""} onChange={(e) => setCol("description", e.target.value)} placeholder="Например: ротационная печь, 2024 г.в." /></label>
            </div>
          )}

          {step === 4 && (
            <div className="stack">
              {app.required_documents.length === 0 ? (
                <div className="alert ok">Для этой заявки документы не обязательны — сведения банк получит из ЕГРЮЛ, ФНС и БКИ.</div>
              ) : (
                <div className="alert warn">Нужны документы: {app.required_documents.map((x) => DOC_LABELS[x]).join(", ")}</div>
              )}
              {[...new Set([...app.required_documents, "BANK_STATEMENT"])].map((dt) => (
                <div key={dt} className="card flat" style={{ padding: 14 }}>
                  <div className="row between">
                    <div>
                      <b>{DOC_LABELS[dt]}</b> {app.required_documents.includes(dt) ? <span className="badge warn">обязательно</span> : <span className="badge neutral">ускорит решение</span>}
                      {dt === "BANK_STATEMENT" && <div className="small muted">CSV: дата;сумма;назначение — распознаём автоматически. <a href={appPath("/samples/bank_statement_sample.csv")} download>Пример файла</a></div>}
                    </div>
                    <label className="btn secondary sm">Загрузить<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.csv,.txt" onChange={(e) => e.target.files?.[0] && upload(dt, e.target.files[0])} /></label>
                  </div>
                  {app.documents.filter((x) => x.doc_type === dt).map((x) => (
                    <div key={x.id} className="small" style={{ marginTop: 6 }}>
                      📄 {x.filename} ({Math.round(x.size / 1024)} КБ)
                      {x.parsed?.ok && <span style={{ color: "var(--ok)" }}> · распознано {x.parsed.operations} операций за {x.parsed.months} мес., поступления {rub(x.parsed.avg_monthly_inflow)}/мес</span>}
                      {x.parsed?.error && <span style={{ color: "var(--bad)" }}> · {x.parsed.error}</span>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {step === 5 && (
            <div className="stack">
              <div className="kv">
                <div>Продукт</div><div>{product.name}</div>
                <div>Сумма и срок</div><div>{rub(app.amount)} на {months(app.term_months)}</div>
                <div>Цель</div><div>{PURPOSES[app.purpose || ""]}</div>
                <div>Выручка за год</div><div>{rub(fin.revenue_last_year)}</div>
                <div>Документы</div><div>{app.documents.length ? app.documents.map((x) => x.filename).join(", ") : "—"}</div>
              </div>
              <label className="check"><input type="checkbox" checked={!!app.consents.bki} onChange={(e) => patch({ consents: { ...app.consents, bki: e.target.checked } }, true)} />
                <span>Согласие на запрос кредитной истории в бюро кредитных историй</span></label>
              <label className="check"><input type="checkbox" checked={!!app.consents.personal_data} onChange={(e) => patch({ consents: { ...app.consents, personal_data: e.target.checked } }, true)} />
                <span>Согласие на обработку данных и получение сведений из ЕГРЮЛ/ФНС</span></label>
              <ErrorBox error={err?.message || null} problems={err?.problems} />
              <button className="btn" disabled={!canNext.every(Boolean)} onClick={submit}>Отправить заявку</button>
              {!canNext.every(Boolean) && <div className="small muted">Не заполнены шаги: {STEPS.filter((_, i) => !canNext[i]).join(", ")}</div>}
            </div>
          )}

          {step < 5 && (
            <div className="row between" style={{ marginTop: 18 }}>
              <button className="btn secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>Назад</button>
              <button className="btn" disabled={!canNext[step]} onClick={() => setStep(step + 1)}>Далее</button>
            </div>
          )}
        </Card>
      </div>

      <Card title="Предварительный расчёт" className="accent">
        <div className="kv" style={{ gridTemplateColumns: "1fr auto" }}>
          <div>Сумма</div><div className="num"><b>{rub(app.amount)}</b></div>
          <div>Срок</div><div>{months(app.term_months)}</div>
          <div>Ставка</div><div>от {calc?.rate_from ?? "…"}%</div>
          <div>Платёж в месяц</div><div className="num"><b>{rub(calc?.monthly_payment)}</b></div>
          <div>Переплата</div><div className="num">{rub(calc?.overpayment)}</div>
        </div>
        {calc?.warnings.map((w) => <div key={w} className="alert warn small" style={{ marginTop: 8 }}>{w}</div>)}
        <p className="small muted" style={{ marginTop: 12 }}>Решение по «{product.name}»: {product.decision_time}. Итоговая ставка зависит от оценки заявки.</p>
        {pre?.unavailable && pre.unavailable.length > 0 && <div className="alert warn small">Часть источников временно недоступна: {pre.unavailable.join(", ")}</div>}
      </Card>
    </div>
  );
}
