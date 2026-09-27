import { useEffect, useState } from 'react';
import type { RunFilter } from './data/model.js';

/** Where the reader is. Everything lives in the URL hash so a link to a run works. */
export type Route =
  | { readonly view: 'overview' }
  | { readonly view: 'tasks' }
  | { readonly view: 'runs'; readonly filter: RunFilter }
  | { readonly view: 'run'; readonly runId: string; readonly filter: RunFilter };

const FILTER_KEYS = ['task', 'arm', 'outcome'] as const;

function readFilter(query: string): RunFilter {
  const params = new URLSearchParams(query);
  const filter: { task?: string; arm?: string; outcome?: string } = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value !== null && value !== '') filter[key] = value;
  }
  return filter;
}

function writeFilter(filter: RunFilter): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filter[key];
    if (value !== undefined) params.set(key, value);
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?', 2);
  const parts = path.split('/').filter((part) => part !== '');
  if (parts[0] === 'tasks') return { view: 'tasks' };
  if (parts[0] === 'runs') {
    const filter = readFilter(query);
    const id = parts[1];
    return id === undefined
      ? { view: 'runs', filter }
      : { view: 'run', runId: decodeURIComponent(id), filter };
  }
  return { view: 'overview' };
}

export function toHash(route: Route): string {
  switch (route.view) {
    case 'overview':
      return '#/';
    case 'tasks':
      return '#/tasks';
    case 'runs':
      return `#/runs${writeFilter(route.filter)}`;
    case 'run':
      return `#/runs/${encodeURIComponent(route.runId)}${writeFilter(route.filter)}`;
  }
}

/** The current route, following `hashchange`. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const update = () => {
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', update);
    return () => {
      window.removeEventListener('hashchange', update);
    };
  }, []);
  return route;
}

export function navigate(route: Route): void {
  window.location.hash = toHash(route);
}
