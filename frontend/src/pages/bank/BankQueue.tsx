import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Loading, StatusBadge } from "../../components/ui";
import { dt, mln, months } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import type { ApplicationShort } from "../../lib/types";

interface Dash {
  by_status: { status: string; label: string; count: number }[];
  total_submitted: number;
  decided: number;
  auto_decision_rate: number;
  approval_rate: number;
  avg_minutes_to_decision: number | null;
  manual_queue: number;
  disbursed_amount: number;
  funnel: Record<string, number>;
}

const FILTERS: [string, string][] = [
  ["MANUAL_REVIEW,COMMITTEE_REVIEW", "Ручное рассмотрение"],
  ["", "Все"],
  ["SUBMITTED,VALIDATION,ENRICHMENT,SCORING", "В конвейере"],
  ["INFO_REQUESTED", "Ждём клиента"],
  ["APPROVED,COUNTER_OFFER,OFFER_ACCEPTED,SIGNING,SIGNED", "Одобрены"],
  ["DISBURSED", "Выданы"],
  ["REJECTED,CANCELLED", "Отказ / отмена"],
];
const FUNNEL_LABEL: Record<string, string> = { SUBMITTED: "Подано", DECIDED: "Решение", OFFER_ACCEPTED: "Принято", SIGNED: "Подписано", DISBURSED: "Выдано" };

export default function BankQueue() {
  const [filter, setFilter] = useState(FILTERS[0][0]);
  const [q, setQ] = useState("");
  const nav = useNavigate();
  const qs = new URLSearchParams();
  if (filter) qs.set("status", filter);
  if (q) qs.set("q", q);
  const list = useApi<ApplicationShort[]>(`/bank/applications?${qs}`, 4000);
  const dash = useApi<Dash>("/bank/dashboard", 5000);
  const events = useApi<{ at: string; number: string; application_id: string; message: string; actor: string }[]>("/bank/events?limit=12", 4000);
  const D = dash.data;
  const maxF = D ? Math.max(...Object.values(D.funnel), 1) : 1;

  return (
    <div className="stack">
      <h1>Кредитный конвейер МСБ</h1>
      {!D ? <Loading /> : (
        <div className="grid g4">
          <div className="card kpi"><div className="v">{D.manual_queue}</div><div className="l">в очереди на ручное рассмотрение</div></div>
          <div className="card kpi"><div className="v">{Math.round(D.auto_decision_rate * 100)}%</div><div className="l">решений принято автоматически</div></div>
          <div className="card kpi"><div className="v">{D.avg_minutes_to_decision != null ? (D.avg_minutes_to_decision < 1 ? "< 1 мин" : `${D.avg_minutes_to_decision} мин`) : "—"}</div><div className="l">среднее время до решения</div></div>
          <div className="card kpi"><div className="v">{mln(D.disbursed_amount)}</div><div className="l">выдано · одобрение {Math.round(D.approval_rate * 100)}%</div></div>
        </div>
      )}

      <div className="grid main-side">
        <Card
          title="Заявки"
          extra={<input style={{ maxWidth: 260 }} placeholder="Номер, ИНН или название" value={q} onChange={(e) => setQ(e.target.value)} />}
        >
          <div className="tabs">
            {FILTERS.map(([v, l]) => (
              <button key={l} className={filter === v ? "active" : ""} onClick={() => setFilter(v)}>{l}</button>
            ))}
          </div>
          {!list.data ? <Loading /> : list.data.length === 0 ? <div className="empty">Нет заявок</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Заявка</th><th>Клиент</th><th>Сумма</th><th>Рейтинг</th><th>Статус</th><th>SLA</th></tr></thead>
                <tbody>
                  {list.data.map((a) => (
                    <tr key={a.id} className="click" onClick={() => nav(`/bank/applications/${a.id}`)}>
                      <td><div className="mono">{a.number}</div><div className="small muted">{a.product_code}</div></td>
                      <td><div>{a.company_name}</div><div className="small muted mono">{a.company_inn}</div></td>
                      <td className="num"><div>{mln(a.amount)}</div><div className="small muted">{months(a.term_months)}</div></td>
                      <td>{a.grade ? <span className={`badge ${a.grade <= "B" ? "ok" : a.grade === "C" ? "warn" : "bad"}`}>{a.grade} · {a.score}</span> : "—"}</td>
                      <td><StatusBadge status={a.status} label={a.status_label} /></td>
                      <td className="small">{a.sla_minutes != null ? <span style={{ color: a.sla_minutes > 240 ? "var(--bad)" : "inherit" }}>{a.sla_minutes} мин</span> : <span className="muted">{dt(a.updated_at)}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="stack">
          {D && (
            <Card title="Воронка">
              {Object.entries(D.funnel).map(([k, v]) => (
                <div key={k} style={{ marginBottom: 8 }}>
                  <div className="row between small"><span>{FUNNEL_LABEL[k]}</span><b>{v}</b></div>
                  <div className="bar"><i style={{ width: `${(v / maxF) * 100}%` }} /></div>
                </div>
              ))}
            </Card>
          )}
          <Card title="Активность">
            {(events.data || []).map((e, i) => (
              <div key={i} className="small" style={{ padding: "6px 0", borderBottom: "1px dashed var(--line)", cursor: "pointer" }} onClick={() => nav(`/bank/applications/${e.application_id}`)}>
                <span className="muted">{dt(e.at)} · {e.number}</span>
                <div>{e.message}</div>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}
