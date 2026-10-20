import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { d } from "../lib/format";
import type { NewsItem } from "../lib/types";

export const CATEGORY: Record<string, string> = {
  MARKET: "Рынок и ставки", SUPPORT: "Господдержка", TAX: "Налоги", PRODUCT: "Предложение банка",
  EDUCATION: "Полезно знать", INDUSTRY: "Ваша отрасль",
};

export default function NewsFeed({ items, onChange, readonly = false }: { items: NewsItem[]; onChange?: () => void; readonly?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const nav = useNavigate();
  const act = async (id: string, action: "CLICK" | "HIDE" | "LIKE") => {
    if (readonly) return;
    await api(`/news/${id}/interact`, { body: { action } });
    if (action !== "CLICK") onChange?.();
  };
  if (!items.length) return <div className="empty">Новостей пока нет</div>;
  return (
    <div>
      {items.map((n) => (
        <article key={n.id} className="news">
          <div className="row between small muted">
            <span className="badge neutral">{CATEGORY[n.category] || n.category}</span>
            <span>{d(n.published_at)}</span>
          </div>
          <h3 style={{ marginTop: 8, cursor: "pointer" }} onClick={() => { setOpen(open === n.id ? null : n.id); act(n.id, "CLICK"); }}>
            {n.title}
          </h3>
          <p className="small" style={{ color: "var(--ink-2)" }}>{n.summary}</p>
          {open === n.id && <p className="small">{n.body}</p>}
          <div className="why">💡 Почему вы это видите: {n.reasons.join(" · ")}</div>
          <div className="row" style={{ marginTop: 8 }}>
            {n.cta_label && n.cta_link && (
              <button className="btn sm secondary" onClick={() => { act(n.id, "CLICK"); nav(n.cta_link!); }}>{n.cta_label}</button>
            )}
            {!readonly && (
              <>
                <button className="btn ghost sm" onClick={() => act(n.id, "LIKE")}>👍 Полезно</button>
                <button className="btn ghost sm" onClick={() => act(n.id, "HIDE")}>Скрыть</button>
              </>
            )}
            {readonly && n.relevance != null && <span className="small muted">релевантность {n.relevance}</span>}
          </div>
        </article>
      ))}
    </div>
  );
}
