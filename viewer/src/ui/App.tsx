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
    <div className={route.name === 'run' ? 'app wide' : 'app'}>
      <div className="topbar">
        <h1>Environment awareness</h1>
        <div className="nav">
          <a className={route.name === 'runs' ? 'active' : ''} href={href.runs()}>
            Results
          </a>
        </div>
        <div className="spacer" />
        <div className="meta">
          <details>
            <summary>Dataset info · v4</summary>
            <div className="dataset-info">
              {index.data?.runs.length ?? 0} runs · {index.data?.resultsDir}
              <br />
              Built {index.data?.generatedAt.slice(0, 16).replace('T', ' ')}
            </div>
          </details>
        </div>
      </div>
      {index.data?.runs.some((r) => r.experiment?.startsWith('fixture-')) && (
        <p className="capture-note fixture-note">
          Engine-driven fixture data · scripted behavior for viewer validation, not model
          evaluation results.
        </p>
      )}
      <main>
        {index.error && (
          <p className="error">Could not load data/index.json: {index.error}</p>
        )}
        {index.data &&
          (route.name === 'run' ? (
            <Cockpit
              runKey={route.key}
              decision={route.decision}
              siblings={index.data.runs}
            />
          ) : route.name === 'experiment' ? (
            <div className="v4-experiment">
              <ExperimentView index={index.data} id={route.id} />
            </div>
          ) : (
            <RunList index={index.data} query={route.query} />
          ))}
      </main>
    </div>
  );
}
