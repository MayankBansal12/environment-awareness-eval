import { useEffect, useState } from 'react';
import type { RunDetail, ViewerIndex } from './model.js';

const cache = new Map<string, Promise<unknown>>();
const load = <T>(url: string) => {
  if (!cache.has(url))
    cache.set(
      url,
      fetch(url).then((r) => {
        if (!r.ok) throw Error(`${url}: ${r.status}`);
        return r.json();
      }),
    );
  return cache.get(url) as Promise<T>;
};

export type Loaded<T> = { data: T; error: null } | { data: null; error: string | null };

function useJson<T>(url: string | null): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null });
  useEffect(() => {
    if (!url) return;
    let live = true;
    setState({ data: null, error: null });
    load<T>(url).then(
      (data) => live && setState({ data, error: null }),
      (e: unknown) => live && setState({ data: null, error: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return state;
}

export const useIndex = () => useJson<ViewerIndex>('data/index.json');
export const useRun = (key: string) =>
  useJson<RunDetail>(`data/runs/${key.split('/').map(encodeURIComponent).join('/')}.json`);
