import { useEffect, useState } from "react";
import NewsFeed, { CATEGORY } from "../../components/NewsFeed";
import { Card, ErrorBox, Loading } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { d } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import type { NewsItem } from "../../lib/types";

interface Co { id: string; name: string; okved: string; okved_name: string; region: string; segment: string; legal_form: string }

const STATUS_OPTS = ["MANUAL_REVIEW", "INFO_REQUESTED", "APPROVED", "COUNTER_OFFER", "SIGNING", "DISBURSED", "REJECTED"];

function Preview({ companies, initial, version }: { companies: Co[]; initial: number; version: number }) {
  const [cid, setCid] = useState(companies[initial]?.id || "");
  const feed = useApi<NewsItem[]>(cid ? `/bank/news/preview?company_id=${cid}&v=${version}` : null);
  const c = companies.find((x) => x.id === cid);
  return (
    <Card>
      <select value={cid} onChange={(e) => setCid(e.target.value)}>
        {companies.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      {c && <div className="small muted" style={{ marginTop: 6 }}>{c.okved} {c.okved_name} · {c.region} · {c.segment} · {c.legal_form}</div>}
      {feed.data ? <NewsFeed items={feed.data.slice(0, 8)} readonly /> : <Loading />}
    </Card>
  );
}

export default function BankNews() {
  const { user } = useAuth();
  const companies = useApi<Co[]>("/bank/companies");
  const all = useApi<NewsItem[]>("/bank/news");
  const [version, setVersion] = useState(0);
  const [form, setForm] = useState({ title: "", summary: "", body: "", category: "INDUSTRY", okved: "", regions: "", segments: "", legal_forms: "", statuses: [] as string[], priority: 30, cta_label: "", cta_link: "" });
  const [err, setErr] = useState<ApiError | null>(null);
  const [ok, setOk] = useState(false);
  const admin = user!.role === "ADMIN";

  useEffect(() => {
    setOk(false);
  }, [form.title]);

  const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const publish = async () => {
    setErr(null);
    const tags: Record<string, string[]> = {};
    if (form.okved) tags.okved = split(form.okved);
    if (form.regions) tags.regions = split(form.regions);
    if (form.segments) tags.segments = split(form.segments);
    if (form.legal_forms) tags.legal_forms = split(form.legal_forms);
    if (form.statuses.length) tags.statuses = form.statuses;
    try {
      await api("/bank/news", {
        body: { title: form.title, summary: form.summary, body: form.body, category: form.category, tags, priority: form.priority,
          cta_label: form.cta_label || null, cta_link: form.cta_link || null, source: "Публикация администратора" },
      });
      setOk(true);
      setVersion(version + 1);
      all.reload();
    } catch (e) {
      setErr(e as ApiError);
    }
  };
  const unpublish = async (id: string) => {
    await api(`/bank/news/${id}`, { method: "DELETE" });
    setVersion(version + 1);
    all.reload();
  };

  return (
    <div className="stack">
      <h1>Персональная лента новостей</h1>
      <p className="muted">Каждый материал размечается тегами таргетинга. Лента клиента ранжируется по его отрасли (ОКВЭД), региону, сегменту, форме бизнеса, этапу заявки и реакциям. Ниже — как лента выглядит для разных клиентов прямо сейчас.</p>

      {companies.data && companies.data.length > 1 && (
        <div className="grid g2">
          <Preview companies={companies.data} initial={Math.max(0, companies.data.findIndex((c) => c.okved?.startsWith("10")))} version={version} />
          <Preview companies={companies.data} initial={Math.max(0, companies.data.findIndex((c) => c.okved?.startsWith("49")))} version={version} />
        </div>
      )}

      <div className="grid g2">
        <Card title="Опубликовать материал">
          {!admin && <div className="alert warn small">Публикация доступна роли «Администратор» (admin@bank.ru).</div>}
          <div className="stack">
            <label className="field"><span>Заголовок</span><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Пекарням: субсидия на закупку печей" /></label>
            <label className="field"><span>Кратко</span><textarea rows={2} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></label>
            <div className="grid g2">
              <label className="field"><span>Рубрика</span><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="field"><span>Приоритет (0–100)</span><input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: +e.target.value })} /></label>
            </div>
            <h3 style={{ marginTop: 8 }}>Таргетинг <span className="small muted">пусто — для всех</span></h3>
            <label className="field"><span>ОКВЭД (префиксы через запятую)</span><input value={form.okved} onChange={(e) => setForm({ ...form, okved: e.target.value })} placeholder="10.7, 56" /></label>
            <label className="field"><span>Регионы</span><input value={form.regions} onChange={(e) => setForm({ ...form, regions: e.target.value })} placeholder="г. Москва, Республика Татарстан" /></label>
            <div className="grid g2">
              <label className="field"><span>Сегменты</span><input value={form.segments} onChange={(e) => setForm({ ...form, segments: e.target.value })} placeholder="micro, small" /></label>
              <label className="field"><span>Форма</span><input value={form.legal_forms} onChange={(e) => setForm({ ...form, legal_forms: e.target.value })} placeholder="IP, OOO" /></label>
            </div>
            <div className="field"><span className="small">Этап заявки клиента</span>
              <div className="chips">{STATUS_OPTS.map((s) => (
                <span key={s} className="chip" style={form.statuses.includes(s) ? { borderColor: "var(--red)", background: "var(--red-soft)" } : undefined}
                  onClick={() => setForm({ ...form, statuses: form.statuses.includes(s) ? form.statuses.filter((x) => x !== s) : [...form.statuses, s] })}>{s}</span>
              ))}</div>
            </div>
            <ErrorBox error={err?.message || null} problems={err?.problems} />
            {ok && <div className="alert ok small">Опубликовано — предпросмотр лент выше обновлён.</div>}
            <button className="btn" disabled={!admin || form.title.length < 5 || form.summary.length < 5} onClick={publish}>Опубликовать</button>
          </div>
        </Card>
        <Card title="Все материалы">
          {!all.data ? <Loading /> : (
            <div className="table-wrap">
              <table className="small">
                <tbody>
                  {all.data.map((n) => (
                    <tr key={n.id} style={{ opacity: n.is_active === false ? 0.4 : 1 }}>
                      <td><b>{n.title}</b><div className="muted">{CATEGORY[n.category]} · {d(n.published_at)} · {Object.entries(n.tags).map(([k, v]) => `${k}: ${v.slice(0, 4).join(",")}${v.length > 4 ? "…" : ""}`).join(" | ") || "для всех"}</div></td>
                      <td>{admin && <button className="btn ghost sm" onClick={() => unpublish(n.id)}>Снять</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
