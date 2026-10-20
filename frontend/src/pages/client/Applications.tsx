import { Link, useNavigate } from "react-router-dom";
import { Card, Loading, StatusBadge } from "../../components/ui";
import { dt, mln, months } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import type { ApplicationShort } from "../../lib/types";

export default function Applications() {
  const { data } = useApi<ApplicationShort[]>("/applications", 5000);
  const nav = useNavigate();
  return (
    <div className="stack">
      <div className="row between">
        <h1>Мои заявки</h1>
        <Link to="/products" className="btn">+ Новая заявка</Link>
      </div>
      <Card>
        {!data ? (
          <Loading />
        ) : data.length === 0 ? (
          <div className="empty">Заявок пока нет</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Номер</th><th>Продукт</th><th>Сумма</th><th>Срок</th><th>Статус</th><th>Обновлена</th></tr>
              </thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id} className="click" onClick={() => nav(`/applications/${a.id}`)}>
                    <td className="mono">{a.number}</td>
                    <td>{a.product_code}</td>
                    <td className="num">{mln(a.amount)}</td>
                    <td>{months(a.term_months)}</td>
                    <td><StatusBadge status={a.status} label={a.status_label} /></td>
                    <td className="small muted">{dt(a.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
