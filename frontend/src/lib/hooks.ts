import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

/** Загрузка данных с опциональным периодическим обновлением (живой статус заявки). */
export function useApi<T>(path: string | null, pollMs?: number | ((data: T | null) => number | undefined)) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const dataRef = useRef<T | null>(null);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      dataRef.current = d;
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  useEffect(() => {
    if (!pollMs) return;
    let timer: number | undefined;
    const tick = () => {
      const ms = typeof pollMs === "function" ? pollMs(dataRef.current) : pollMs;
      timer = window.setTimeout(async () => {
        if (ms) await reload();
        tick();
      }, ms || 3000);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [pollMs, reload]);

  return { data, setData, error, loading, reload };
}
