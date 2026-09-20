import { useEffect, useState } from 'react';
import type { RunDetail, ViewerIndex } from './model.js';

const values = new Map<string, unknown>();
const requests = new Map<string, Promise<unknown>>();
const load = <T>(url: string): Promise<T> => {
  if (values.has(url)) return Promise.resolve(values.get(url) as T);
  if (!requests.has(url)) {
    const request = fetch(url)
      .then((r) => {
        if (!r.ok) throw Error(`${url}: ${r.status}`);
        return r.json();
      })
      .then((data: unknown) => {
        values.set(url, data);
        return data;
      })
      .finally(() => requests.delete(url));
    requests.set(url, request);
  }
  return requests.get(url) as Promise<T>;
};

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  retry: () => void;
}

function useJson<T>(url: string, keepPrevious = false): Loaded<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ url: string; data: T | null; error: string | null }>(
    () => ({ url, data: (values.get(url) as T | undefined) ?? null, error: null }),
  );
  useEffect(() => {
    let live = true;
    load<T>(url).then(
      (data) => live && setState({ url, data, error: null }),
      (e: unknown) =>
        live &&
        setState((previous) => ({
          url,
          data: keepPrevious ? previous.data : null,
          error: String(e),
        })),
    );
    return () => {
      live = false;
    };
  }, [url, keepPrevious, attempt]);

  const cached = values.has(url);
  const error = !cached && state.url === url ? state.error : null;
  return {
    data: cached ? (values.get(url) as T) : keepPrevious ? state.data : null,
    error,
    loading: !cached && error === null,
    retry: () => {
      setState((previous) => ({ ...previous, error: null }));
      setAttempt((value) => value + 1);
    },
  };
}

const runUrl = (key: string) =>
  `data/runs/${key.split('/').map(encodeURIComponent).join('/')}.json`;

export const useIndex = () => useJson<ViewerIndex>('data/index.json');
export const useRun = (key: string, keepPrevious = false) =>
  useJson<RunDetail>(runUrl(key), keepPrevious);

/** Reuses the same request as navigation; a failed prefetch can be retried on click. */
export const prefetchRun = (key: string) =>
  load<RunDetail>(runUrl(key)).catch(() => undefined);
