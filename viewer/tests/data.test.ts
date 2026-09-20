import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('run data cache', () => {
  it('shares in-flight prefetch requests and renders cached runs immediately', async () => {
    let respond!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const { prefetchRun, useRun } = await import('../src/data.js');
    const first = prefetchRun('experiment/run one');
    const second = prefetchRun('experiment/run one');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('data/runs/experiment/run%20one.json');
    respond(new Response(JSON.stringify({ key: 'experiment/run one' })));
    await Promise.all([first, second]);
    function CachedRun() {
      const loaded = useRun('experiment/run one');
      return createElement('span', null, loaded.loading ? 'Loading' : loaded.data?.key);
    }
    expect(renderToStaticMarkup(createElement(CachedRun))).toContain('experiment/run one');
    await prefetchRun('experiment/run one');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('allows a failed prefetch to be retried without caching the error', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: 'run-2' })));
    vi.stubGlobal('fetch', fetch);
    const { prefetchRun } = await import('../src/data.js');
    expect(await prefetchRun('run-2')).toBeUndefined();
    expect(await prefetchRun('run-2')).toEqual({ key: 'run-2' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
