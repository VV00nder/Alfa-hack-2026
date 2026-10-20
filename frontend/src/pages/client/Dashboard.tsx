import { Link, useNavigate } from "react-router-dom";
import NewsFeed from "../../components/NewsFeed";
import { Card, Loading, StatusBadge, Stepper } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { d, IN_PROGRESS, mln, months } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import type { Application, ApplicationShort, NewsItem } from "../../lib/types";

const ACTION = new Set(["DRAFT", "INFO_REQUESTED", "APPROVED", "COUNTER_OFFER", "SIGNING"]);

function ActiveApp({ id }: { id: string }) {
  const { data: a } = useApi<Application>(`/applications/${id}`, (x) => (x && IN_PROGRESS.has(x.status) ? 2000 : 8000));
  const nav = useNavigate();
  if (!a) return <Loading />;
  return (
    <div className="card accent" style={{ cursor: "pointer" }} onClick={() => nav(`/applications/${a.id}`)}>
      <div className="row between">
        <div>
          <div className="small muted">Заявка {a.number} · {a.product.name}</div>
          <h2 style={{ margin: "4px 0" }}>{mln(a.amount)} на {months(a.term_months)}</h2>
        </div>
        <StatusBadge status={a.status} label={a.status_label} />
      </div>
      <Stepper stage={a.stage} status={a.status} />
      <div className="row between" style={{ marginTop: 10 }}>
        <span className="small">{a.status_hint}</span>
        {a.next_action && <button className="btn sm">{a.next_action} →</button>}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const apps = useApi<ApplicationShort[]>("/applications", 10000);
  const feed = useApi<NewsItem[]>("/news/feed", 15000);
  const nav = useNavigate();
  const c = user!.company!;
  const active = (apps.data || []).filter((a) => !["REJECTED", "CANCELLED", "DISBURSED"].includes(a.status));
  const loans = (apps.data || []).filter((a) => a.status === "DISBURSED");

  return (
    <div className="grid main-side">
      <div className="stack">
        <div>
          <h1>Здравствуйте, {user!.full_name.split(" ")[0]}!</h1>
          <p className="muted">{c.name} · ИНН {c.inn} · {c.okved} {c.okved_name}</p>
        </div>

        {active.length === 0 ? (
          <Card className="accent">
            <h2>Нужно финансирование для бизнеса?</h2>
            <p className="muted">Расскажите о задаче — подберём продукт и рассчитаем платёж. Данные о компании банк получит сам из ЕГРЮЛ и ФНС.</p>
            <div className="row" style={{ marginTop: 12 }}>
              <Link to="/products" className="btn">Подобрать кредит</Link>
              <span className="small muted">или спросите помощника справа внизу</span>
            </div>
          </Card>
        ) : (
          <>
            <h2 style={{ marginTop: 8 }}>Текущие заявки</h2>
            {active
              .sort((a, b) => Number(ACTION.has(b.status)) - Number(ACTION.has(a.status)))
              .map((a) => (
                <ActiveApp key={a.id} id={a.id} />
              ))}
            <Link to="/products" className="btn secondary" style={{ alignSelf: "flex-start" }}>+ Новая заявка</Link>
          </>
        )}

        {loans.length > 0 && (
          <Card title="Мои кредиты">
            <table>
              <tbody>
                {loans.map((l) => (
                  <tr key={l.id} className="click" onClick={() => nav(`/applications/${l.id}`)}>
                    <td>{l.number}</td>
                    <td className="num">{mln(l.amount)}</td>
                    <td>{months(l.term_months)}</td>
                    <td className="small muted">выдан {d(l.decided_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        <Card title="Профиль компании" extra={<span className="small muted">по данным ЕГРЮЛ</span>}>
          <div className="kv">
            <div>Наименование</div><div>{c.name}</div>
            <div>ОГРН</div><div className="mono">{c.ogrn}</div>
            <div>Вид деятельности</div><div>{c.okved} — {c.okved_name}</div>
            <div>Регион</div><div>{c.region}</div>
            <div>Руководитель</div><div>{c.director_name}</div>
            <div>Дата регистрации</div><div>{d(c.registration_date)}</div>
          </div>
        </Card>
      </div>

      <Card title="Для вашего бизнеса" extra={<span className="small muted">персональная лента</span>}>
        {feed.data ? <NewsFeed items={feed.data} onChange={feed.reload} /> : <Loading />}
      </Card>
    </div>
  );
}
