import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import DemoBanner from "../components/DemoBanner";
import { ErrorBox } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { isEmployee, useAuth } from "../lib/auth";

interface Demo {
  email: string;
  password: string;
  role: string;
  title: string;
  hint: string;
}

export default function Login() {
  const { user, login, register } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [inn, setInn] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<Demo[]>([]);

  useEffect(() => {
    api<Demo[]>("/auth/demo-accounts").then(setDemo).catch(() => setDemo([]));
  }, []);

  if (user) return <Navigate to={isEmployee(user) ? "/bank" : "/"} replace />;

  const go = async (fn: () => Promise<{ role: string }>) => {
    setBusy(true);
    setErr(null);
    try {
      const u = await fn();
      nav(u.role === "CLIENT" ? "/" : "/bank");
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <DemoBanner />
    <div className="login-wrap">
      <div className="login-hero">
        <div className="logo" style={{ color: "#fff", marginBottom: 24 }}>
          <span className="logo-mark">C</span> CreditFlow
        </div>
        <h1>Умный кредитный кабинет предпринимателя</h1>
        <p style={{ opacity: 0.8, fontSize: 17 }}>Путь от потребности до денег на счёте и прозрачный процесс внутри банка в одном продукте.</p>
        <ul style={{ opacity: 0.9, paddingLeft: 18 }}>
          <li>Подбор продукта под задачу бизнеса: анкета или описание своими словами</li>
          <li>Данные о компании подтягиваются из ЕГРЮЛ и ФНС — без повторного ввода</li>
          <li>Живой статус заявки, понятные причины решения и встречные предложения</li>
          <li>Рабочее место аналитика: данные источников, скоринг, решение в один клик</li>
        </ul>
        <p className="small" style={{ opacity: 0.6, marginTop: 24 }}>Прототип для хакатона. Все данные синтетические.</p>
      </div>
      <div className="login-form">
        <div className="tabs">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Вход</button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Регистрация по ИНН</button>
        </div>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            go(() => (mode === "login" ? login(email, password) : register({ email, password, full_name: fullName, inn })));
          }}
        >
          {mode === "register" && (
            <>
              <label className="field"><span>ИНН компании или ИП</span><input value={inn} onChange={(e) => setInn(e.target.value.trim())} placeholder="10 или 12 цифр" required /></label>
              <div className="hint" style={{ marginTop: -6 }}>Подойдёт любой корректный ИНН: данные компании сгенерирует симулятор ЕГРЮЛ. Например, 7720123457.</div>
              <label className="field"><span>Ваше ФИО</span><input value={fullName} onChange={(e) => setFullName(e.target.value)} required /></label>
            </>
          )}
          <label className="field"><span>E-mail</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></label>
          <label className="field"><span>Пароль</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === "register" ? 8 : 6} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
          <ErrorBox error={err?.message || null} problems={err?.problems} />
          <button className="btn block" disabled={busy}>{busy ? "…" : mode === "login" ? "Войти" : "Зарегистрироваться"}</button>
        </form>

        {demo.length > 0 && mode === "login" && (
          <div style={{ marginTop: 24 }}>
            <h3>Тестовые учётные записи</h3>
            <p className="small muted">Вход в один клик. Каждый клиент ведёт к своему исходу заявки.</p>
            <div className="demo-acc">
              {demo.map((a) => (
                <button key={a.email} onClick={() => go(() => login(a.email, a.password))} disabled={busy}>
                  <div className="row between">
                    <b>{a.title}</b>
                    <span className={`badge ${a.role === "CLIENT" ? "red" : "neutral"}`}>{a.role === "CLIENT" ? "клиент" : "банк"}</span>
                  </div>
                  <div className="small muted">{a.email} · {a.hint}</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
