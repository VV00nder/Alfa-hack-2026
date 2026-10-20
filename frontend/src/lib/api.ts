import { demoApi, demoDocument } from "../demo/server";

const BASE = "/api/v1";
/** Демо-режим для статического хостинга: API выполняется в браузере (см. src/demo). */
export const DEMO = import.meta.env.VITE_DEMO_MODE === "true";
export const appPath = (p: string) => import.meta.env.BASE_URL.replace(/\/$/, "") + p;
const TOKEN_KEY = "cf_token";
// Хук для автотестов демо-режима из консоли браузера: await cfDemoApi("GET", "/products", token)
if (DEMO) (window as unknown as { cfDemoApi: typeof demoApi }).cfDemoApi = demoApi;

export class ApiError extends Error {
  status: number;
  problems: string[];
  constructor(status: number, message: string, problems: string[] = []) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* хранилище недоступно — токен живёт только в памяти вкладки */
  }
}

function parseError(status: number, body: unknown): ApiError {
  const detail = (body as { detail?: unknown })?.detail;
  if (typeof detail === "string") return new ApiError(status, detail);
  if (Array.isArray(detail)) {
    const msgs = detail.map((d: { msg?: string; loc?: string[] }) => `${(d.loc || []).slice(1).join(".")}: ${d.msg}`);
    return new ApiError(status, "Проверьте правильность заполнения", msgs);
  }
  if (detail && typeof detail === "object") {
    const d = detail as { message?: string; problems?: string[] };
    return new ApiError(status, d.message || "Ошибка", d.problems || []);
  }
  return new ApiError(status, `Ошибка ${status}`);
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const method = opts.method || (body ? "POST" : "GET");
  if (DEMO) {
    const r = await demoApi(method, path, token, opts.body, opts.form);
    if (r.status === 401 && token) {
      setToken(null);
      window.location.href = appPath("/login");
    }
    if (r.status >= 400) throw parseError(r.status, r.data);
    return r.data as T;
  }
  const res = await fetch(BASE + path, { method, headers, body });
  if (res.status === 401 && token) {
    setToken(null);
    window.location.href = appPath("/login");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw parseError(res.status, data);
  return data as T;
}

export async function openDocument(appId: string, docId: string) {
  if (DEMO) {
    const blob = demoDocument(appId, docId);
    if (blob) window.open(URL.createObjectURL(blob), "_blank");
    return;
  }
  const res = await fetch(`${BASE}/applications/${appId}/documents/${docId}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  const blob = await res.blob();
  window.open(URL.createObjectURL(blob), "_blank");
}
