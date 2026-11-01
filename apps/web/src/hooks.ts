import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (update: T | ((prev: T | undefined) => T)) => void;
}

/** Încarcă date; răspunsurile vechi sunt ignorate dacă dependențele s-au schimbat între timp. */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const run = useRef(0);
  const latest = useRef(fn);
  latest.current = fn;

  const reload = useCallback(async () => {
    const id = ++run.current;
    setLoading(true);
    setError(null);
    try {
      const result = await latest.current();
      if (id === run.current) setDataState(result);
    } catch (err) {
      if (id === run.current) setError(err);
    } finally {
      if (id === run.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => { run.current++; };
  }, deps);

  const setData = useCallback((update: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) => (typeof update === 'function' ? (update as (p: T | undefined) => T)(prev) : update));
  }, []);

  return { data, error, loading, reload, setData };
}

/** Rulează periodic; nu solicită serverul cât timp fila nu este vizibilă. */
export function useInterval(fn: () => void, ms: number, enabled = true) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') latest.current();
    }, ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
}

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · SeaDoc` : 'SeaDoc';
  }, [title]);
}
