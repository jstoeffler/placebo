import { describe, expect, it } from 'vitest';
import { parseHash, toHash, type Route } from './route.js';

describe('routes', () => {
  it.each<[string, Route]>([
    ['', { view: 'overview' }],
    ['#/', { view: 'overview' }],
    ['#/nowhere', { view: 'overview' }],
    ['#/tasks', { view: 'tasks' }],
    ['#/runs', { view: 'runs', filter: {} }],
    [
      '#/runs?task=fix&arm=none&outcome=failed',
      {
        view: 'runs',
        filter: { task: 'fix', arm: 'none', outcome: 'failed' },
      },
    ],
    ['#/runs/run%2F1?arm=control', { view: 'run', runId: 'run/1', filter: { arm: 'control' } }],
  ])('parses %j', (hash, route) => {
    expect(parseHash(hash)).toEqual(route);
  });

  it('round-trips', () => {
    const routes: Route[] = [
      { view: 'overview' },
      { view: 'tasks' },
      { view: 'runs', filter: { task: 'a', outcome: 'crashed' } },
      { view: 'run', runId: 'run 7', filter: { arm: 'tests-first' } },
    ];
    for (const route of routes) expect(parseHash(toHash(route))).toEqual(route);
  });
});
