import { useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { isEmployee, useAuth } from "../lib/auth";
import { dt } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { Notification } from "../lib/types";
import Assistant from "./Assistant";
import DemoBanner from "./DemoBanner";

const ROLE_LABEL: Record<string, string> = { ANALYST: "Кредитный аналитик", RISK_MANAGER: "Риск-менеджер", ADMIN: "Администратор" };

function Notifications() {
  const [open, setOpen] = useState(false);
  const { data, reload } = useApi<Notification[]>("/notifications", 5000);
  const nav = useNavigate();
  const unread = (data || []).filter((n) => !n.is_read).length;
  const toggle = async () => {
    setOpen(!open);
    if (!open && unread) {
      await api("/notifications/read-all", { method: "POST" });
      setTimeout(reload, 1500);
    }
  };
  return (
    <>
      <button className="btn ghost bell" onClick={toggle} aria-label="Уведомления">
        🔔{unread > 0 && <span className="cnt">{unread}</span>}
      </button>
      {open && <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onClick={() => setOpen(false)} />}
      {open && (
        <div className="drawer">
          <div className="row between" style={{ padding: "6px 8px" }}>
            <b>Уведомления</b>
            <span className="small muted">только в личном кабинете</span>
          </div>
          {(data || []).length === 0 && <div className="empty small">Пока пусто</div>}
          {(data || []).map((n) => (
            <div
              key={n.id}
              className={`notif ${n.is_read ? "" : "unread"}`}
              style={{ cursor: n.application_id ? "pointer" : "default" }}
              onClick={() => {
                if (n.application_id) {
                  setOpen(false);
                  nav(`/applications/${n.application_id}`);
                }
              }}
            >
              <div className="small muted">{dt(n.created_at)}</div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {n.kind === "SIGN_CODE" ? "🔐 " : n.kind === "ACTION_REQUIRED" ? "⚡ " : ""}
                {n.title}
              </div>
              <div className="small">{n.body}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const emp = isEmployee(user);
  return (
    <>
      <DemoBanner />
      <header className="topbar">
        <div className="topbar-in">
          <Link to={emp ? "/bank" : "/"} className="logo" style={{ textDecoration: "none" }}>
            <span className="logo-mark">C</span>
            <span>CreditFlow{emp && <span className="badge neutral" style={{ marginLeft: 8 }}>Банк</span>}</span>
          </Link>
          <nav className="nav">
            {emp ? (
              <>
                <NavLink to="/bank" end>Очередь и метрики</NavLink>
                <NavLink to="/bank/news">Лента новостей</NavLink>
              </>
            ) : (
              <>
                <NavLink to="/" end>Главная</NavLink>
                <NavLink to="/products">Подобрать кредит</NavLink>
                <NavLink to="/applications">Мои заявки</NavLink>
              </>
            )}
          </nav>
          <div className="who">
            {!emp && <Notifications />}
            <div style={{ textAlign: "right" }}>
              <div className="name">{user?.full_name}</div>
              <div className="muted small">{emp ? ROLE_LABEL[user!.role] : user?.company?.name}</div>
            </div>
            <button
              className="btn ghost sm"
              onClick={() => {
                logout();
                nav("/login");
              }}
            >
              Выйти
            </button>
          </div>
        </div>
      </header>
      <main className="page">{children}</main>
      {!emp && <Assistant />}
    </>
  );
}
