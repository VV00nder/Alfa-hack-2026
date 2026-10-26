import { DEMO, setToken } from "../lib/api";
import { resetDemo } from "../demo/server";

/** Плашка демо-режима (GitHub Pages): данные живут в браузере, полная версия — в Docker. */
export default function DemoBanner() {
  if (!DEMO) return null;
  return (
    <div className="demo-banner">
      <span>
        <b>Демо-версия в браузере.</b> Конвейер, скоринг и лента работают локально, данные хранятся только у вас. Полная версия (PostgreSQL, воркеры, внешние системы) —{" "}
        <a href="https://github.com/VV00nder/Alfa-hack-2026#2-быстрый-старт" target="_blank" rel="noreferrer">docker compose up</a>.
      </span>
      <button
        className="btn ghost sm"
        onClick={() => {
          if (!confirm("Сбросить демо-данные к исходному состоянию?")) return;
          resetDemo();
          setToken(null);
          window.location.href = import.meta.env.BASE_URL + "login";
        }}
      >
        Сбросить данные
      </button>
    </div>
  );
}
