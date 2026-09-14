import { useEffect, useState } from 'react';
import { useIndex } from '../data.js';
import { Cockpit } from './Cockpit.js';
import { ExperimentView } from './ExperimentView.js';
import { RunList } from './RunList.js';

export type Route =
  | { name: 'runs'; query: URLSearchParams }
  | { name: 'run'; key: string; decision: number | null }
  | { name: 'experiment'; id: string };

export function parseRoute(hash: string): Route {
  const [pathPart = '', search = ''] = hash.replace(/^#\/?/, '').split('?');
  const [head, ...rest] = pathPart.split('/').map(decodeURIComponent);
  if (head === 'run' && rest.length) {
    const last = rest.at(-1)!;
    const decision = /^d\d+$/.test(last) ? Number(last.slice(1)) : null;
    return { name: 'run', key: (decision ? rest.slice(0, -1) : rest).join('/'), decision };
  }
  if (head === 'experiment' && rest[0]) return { name: 'experiment', id: rest[0] };
  return { name: 'runs', query: new URLSearchParams(search) };
}

export const href = {
  runs: (query?: Record<string, string>) =>
    '#/' + (query ? '?' + new URLSearchParams(query).toString() : ''),
  run: (key: string, decision?: number | null) =>
    `#/run/${key.split('/').map(encodeURIComponent).join('/')}${decision ? `/d${decision}` : ''}`,
  experiment: (id: string) => `#/experiment/${encodeURIComponent(id)}`,
};

export function App() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const index = useIndex();

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href.runs()}>
          Environment awareness <span>v4</span>
        </a>
        <nav>
          <a className={route.name !== 'experiment' ? 'active' : ''} href={href.runs()}>
            Runs
          </a>
          {index.data?.experiments.map((e) => (
            <a
              key={e.id}
              className={route.name === 'experiment' && route.id === e.id ? 'active' : ''}
              href={href.experiment(e.id)}
            >
              {e.id}
            </a>
          ))}
        </nav>
        {index.data && (
          <span className="muted small">
            {index.data.runs.length} runs · built{' '}
            {index.data.generatedAt.slice(0, 16).replace('T', ' ')}
          </span>
        )}
      </header>
      <main>
        {index.error && (
          <p className="error">Could not load data/index.json: {index.error}</p>
        )}
        {index.data &&
          (route.name === 'run' ? (
            <Cockpit key={route.key} runKey={route.key} decision={route.decision} />
          ) : route.name === 'experiment' ? (
            <ExperimentView index={index.data} id={route.id} />
          ) : (
            <RunList index={index.data} query={route.query} />
          ))}
      </main>
    </div>
  );
}
