import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, Loading, MoneyInput } from "../../components/ui";
import { api } from "../../lib/api";
import { mln, months, PURPOSES, rub } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import type { Product, Recommendation } from "../../lib/types";

interface RecResp {
  engine: string;
  parsed: { purpose: string | null; amount: number | null; term_months: number | null } | null;
  request: { purpose: string | null; amount: number | null; term_months: number | null; has_collateral: boolean };
  recommendations: Recommendation[];
}

export default function Products() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const products = useApi<Product[]>("/products");
  const [purpose, setPurpose] = useState<string>("");
  const [amount, setAmount] = useState(3_000_000);
  const [term, setTerm] = useState(24);
  const [collateral, setCollateral] = useState(false);
  const [text, setText] = useState("");
  const [res, setRes] = useState<RecResp | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (useText = false) => {
    setBusy(true);
    try {
      const r = await api<RecResp>("/products/recommend", {
        body: useText ? { text } : { purpose: purpose || null, amount, term_months: term, has_collateral: collateral },
      });
      setRes(r);
      if (useText) {
        if (r.request.purpose) setPurpose(r.request.purpose);
        if (r.request.amount) setAmount(r.request.amount);
        if (r.request.term_months) setTerm(r.request.term_months);
        setCollateral(r.request.has_collateral);
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purpose, collateral]);

  const start = (code: string) => {
    const q = new URLSearchParams({ product: code, amount: String(amount), term: String(term) });
    if (purpose) q.set("purpose", purpose);
    nav(`/applications/new?${q}`);
  };

  const highlight = params.get("product");

  return (
    <div className="stack">
      <h1>Подбор кредита</h1>
      <p className="muted">Опишите задачу своими словами или ответьте на три вопроса — мы покажем подходящие продукты и объясним почему.</p>

      <div className="grid g2">
        <Card title="✨ Опишите задачу">
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Например: хочу купить вторую печь за 3,5 млн, отдавать года два, залога нет" maxLength={1000} />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" disabled={!text.trim() || busy} onClick={() => run(true)}>Подобрать</button>
            {res?.parsed && (
              <span className="small muted">
                Понял: {res.parsed.purpose ? PURPOSES[res.parsed.purpose] : "цель не указана"}
                {res.parsed.amount ? `, ${mln(res.parsed.amount)}` : ""}
                {res.parsed.term_months ? `, ${months(res.parsed.term_months)}` : ""} · {res.engine === "rules" ? "правила" : res.engine}
              </span>
            )}
          </div>
        </Card>
        <Card title="Или по параметрам">
          <div className="stack">
            <label className="field">
              <span>На что нужны деньги</span>
              <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                <option value="">Любая цель</option>
                {Object.entries(PURPOSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <div className="grid g2">
              <label className="field"><span>Сумма, ₽</span><MoneyInput value={amount} onChange={setAmount} /></label>
              <label className="field"><span>Срок: {months(term)}</span><input type="range" min={1} max={84} value={term} onChange={(e) => setTerm(+e.target.value)} onMouseUp={() => run(false)} onTouchEnd={() => run(false)} /></label>
            </div>
            <div className="row between">
              <label className="check"><input type="checkbox" checked={collateral} onChange={(e) => setCollateral(e.target.checked)} /> Есть имущество для залога</label>
              <button className="btn secondary sm" onClick={() => run(false)}>Пересчитать</button>
            </div>
          </div>
        </Card>
      </div>

      <h2 style={{ marginTop: 12 }}>Подходящие продукты</h2>
      {!res ? <Loading /> : (
        <div className="grid g3">
          {res.recommendations.map((r, i) => {
            const p = products.data?.find((x) => x.code === r.product_code);
            const unsuitable = r.limitations.length > 0 && r.fit < 0;
            return (
              <div key={r.product_code} className={`card ${i === 0 && !unsuitable ? "accent" : ""}`} style={{ opacity: unsuitable ? 0.6 : 1, outline: highlight === r.product_code ? "2px solid var(--red)" : undefined }}>
                <div className="row between">
                  <h3 style={{ margin: 0 }}>{r.name}</h3>
                  {i === 0 && !unsuitable && <span className="badge red">Лучший вариант</span>}
                </div>
                <p className="small muted" style={{ marginTop: 4 }}>{r.tagline}</p>
                <div className="kv small" style={{ gridTemplateColumns: "1fr auto", margin: "10px 0" }}>
                  <div>Ставка</div><div><b>от {r.rate_from}%</b></div>
                  <div>Платёж*</div><div className="num"><b>{rub(r.example_payment)}</b>/мес</div>
                  <div>Решение</div><div>{r.decision_time}</div>
                  {p && (<><div>Сумма</div><div>{mln(p.min_amount)} – {mln(p.max_amount)}</div></>)}
                </div>
                {r.reasons.length > 0 && <div className="small" style={{ color: "var(--ok)" }}>✓ {r.reasons.join(" · ")}</div>}
                {r.limitations.length > 0 && <div className="small" style={{ color: "var(--warn)", marginTop: 4 }}>⚠ {r.limitations.join(" · ")}</div>}
                <button className="btn block" style={{ marginTop: 12 }} disabled={unsuitable} onClick={() => start(r.product_code)}>Оформить</button>
              </div>
            );
          })}
        </div>
      )}
      <p className="small muted">* Платёж рассчитан для {mln(amount)} на {months(term)} по минимальной ставке. Итоговые условия зависят от оценки заявки.</p>
    </div>
  );
}
