import type { ReactNode } from "react";
import { STATUS_TONE } from "../lib/format";
import type { AppEvent } from "../lib/types";
import { dt } from "../lib/format";

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone = STATUS_TONE[status] || "neutral";
  const live = ["SUBMITTED", "VALIDATION", "ENRICHMENT", "SCORING", "OFFER_ACCEPTED", "SIGNED"].includes(status);
  return (
    <span className={`badge ${tone}`}>
      <span className={`dot ${live ? "pulse" : ""}`} />
      {label}
    </span>
  );
}

const STAGES = ["Заявка", "Проверка", "Оценка", "Решение", "Договор", "Деньги"];

export function Stepper({ stage, status }: { stage: number; status: string }) {
  const failed = status === "REJECTED" || status === "CANCELLED";
  return (
    <div className="stepper" aria-label="Этапы заявки">
      {STAGES.map((s, i) => {
        const n = i + 1;
        const cls = n < stage || (n === stage && status === "DISBURSED") ? "done" : n === stage ? "current" : "";
        return (
          <div key={s} className={`step ${cls}`}>
            <div className="c" style={failed && n === stage ? { background: "var(--muted)" } : undefined}>
              {cls === "done" ? "✓" : n}
            </div>
            {s}
          </div>
        );
      })}
    </div>
  );
}

export function Timeline({ events, showActor = false }: { events: AppEvent[]; showActor?: boolean }) {
  const list = [...events].reverse();
  return (
    <ul className="timeline">
      {list.map((e) => (
        <li key={e.id} className={e.actor_type === "SYSTEM" ? "sys" : e.actor_type === "EMPLOYEE" ? "emp" : "cli"}>
          <div className="small muted">
            {dt(e.created_at)}
            {showActor && e.actor_name ? ` · ${e.actor_name}` : ""}
          </div>
          <div style={{ fontSize: 14 }}>{e.message}</div>
        </li>
      ))}
    </ul>
  );
}

export function Card({ title, extra, children, className = "" }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || extra) && (
        <div className="card-title">
          {typeof title === "string" ? <h2 style={{ margin: 0 }}>{title}</h2> : title}
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

export function Loading() {
  return (
    <div className="empty">
      <span className="spinner" />
    </div>
  );
}

export function ErrorBox({ error, problems }: { error: string | null; problems?: string[] }) {
  if (!error) return null;
  return (
    <div className="alert bad" role="alert">
      <b>{error}</b>
      {problems && problems.length > 0 && (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MoneyInput({ value, onChange, placeholder }: { value: number | undefined | null; onChange: (v: number) => void; placeholder?: string }) {
  return (
    <input
      inputMode="numeric"
      placeholder={placeholder}
      value={value ? value.toLocaleString("ru-RU") : ""}
      onChange={(e) => onChange(Number(e.target.value.replace(/[^\d]/g, "")) || 0)}
    />
  );
}
