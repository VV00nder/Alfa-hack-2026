import { useEffect, useRef, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { Recommendation } from "../lib/types";

interface Msg {
  from: "me" | "bot";
  text: string;
  engine?: string;
  recs?: Recommendation[];
  parsed?: { amount?: number; term_months?: number; purpose?: string };
}

const START = ["Нужно 3 млн на новое оборудование на 2 года", "Что сейчас с моей заявкой?", "Как считается лимит?", "Какие документы нужны?"];

export default function Assistant() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { from: "bot", text: "Здравствуйте! Я помогу подобрать кредит под задачу бизнеса, объясню статус заявки и условия. Опишите задачу своими словами." },
  ]);
  const [suggest, setSuggest] = useState<string[]>(START);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const match = useMatch("/applications/:id");
  const appId = match?.params.id && match.params.id !== "new" ? match.params.id : undefined;
  const nav = useNavigate();
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, open]);

  const send = async (m: string) => {
    if (!m.trim() || busy) return;
    setMsgs((x) => [...x, { from: "me", text: m }]);
    setText("");
    setBusy(true);
    try {
      const r = await api<{ answer: string; engine: string; recommendations?: Recommendation[]; parsed?: Msg["parsed"]; suggestions: string[] }>(
        "/assistant/chat",
        { body: { message: m, application_id: appId } },
      );
      setMsgs((x) => [...x, { from: "bot", text: r.answer, engine: r.engine, recs: r.recommendations?.slice(0, 2), parsed: r.parsed }]);
      setSuggest(r.suggestions.filter((s) => !s.startsWith("Оформить")));
    } catch (e) {
      setMsgs((x) => [...x, { from: "bot", text: "Не получилось ответить: " + (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  const apply = (r: Recommendation, p?: Msg["parsed"]) => {
    const q = new URLSearchParams({ product: r.product_code });
    if (p?.amount) q.set("amount", String(p.amount));
    if (p?.term_months) q.set("term", String(p.term_months));
    if (p?.purpose) q.set("purpose", p.purpose);
    setOpen(false);
    nav(`/applications/new?${q}`);
  };

  return (
    <>
      <button className="btn fab" onClick={() => setOpen(!open)} aria-label="ИИ-ассистент">
        {open ? "✕" : "💬 Помощник"}
      </button>
      {open && (
        <div className="chat" role="dialog" aria-label="Ассистент">
          <div className="chat-h">
            <div>
              <b>Кредитный помощник</b>
              <div className="small" style={{ opacity: 0.7 }}>{appId ? "Учитываю данные открытой заявки" : "Подбор кредита и ответы на вопросы"}</div>
            </div>
          </div>
          <div className="chat-b">
            {msgs.map((m, i) => (
              <div key={i}>
                <div className={`msg ${m.from}`}>{m.text}</div>
                {m.recs?.map((r) => (
                  <div key={r.product_code} className="card flat" style={{ padding: 12, marginBottom: 8 }}>
                    <div className="row between">
                      <b>{r.name}</b>
                      <span className="badge ok">от {r.rate_from}%</span>
                    </div>
                    <div className="small muted">{r.reasons.join(" · ") || r.tagline}</div>
                    <button className="btn sm" style={{ marginTop: 8 }} onClick={() => apply(r, m.parsed)}>
                      Оформить с этими параметрами
                    </button>
                  </div>
                ))}
                {m.engine && <div className="small muted" style={{ margin: "-4px 0 8px" }}>{m.engine === "rules" ? "ответ по правилам и базе знаний" : `модель ${m.engine.replace("llm:", "")}`}</div>}
              </div>
            ))}
            {busy && <div className="msg bot"><span className="spinner" /></div>}
            <div className="chips">
              {suggest.map((s) => (
                <span key={s} className="chip" onClick={() => send(s)}>{s}</span>
              ))}
            </div>
            <div ref={end} />
          </div>
          <form className="chat-f" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Например: нужно 5 млн на закупку на год" maxLength={1000} />
            <button className="btn" disabled={busy}>➤</button>
          </form>
        </div>
      )}
    </>
  );
}
