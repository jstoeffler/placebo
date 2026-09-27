import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';
import { readEmbedded } from './embedded.js';

describe('App', () => {
  it('says when no results are embedded', () => {
    expect(renderToStaticMarkup(<App embedded={{ state: 'absent' }} />)).toContain(
      'No results embedded',
    );
  });

  it('shows the experiment id and schema version', () => {
    const html = renderToStaticMarkup(
      <App embedded={readEmbedded('{"schemaVersion":1,"experiment":{"id":"exp-42"}}')} />,
    );
    expect(html).toContain('exp-42');
    expect(html).toContain('<dd>1</dd>');
  });

  it('explains unreadable results', () => {
    expect(renderToStaticMarkup(<App embedded={readEmbedded('{')} />)).toContain(
      'Cannot read results: embedded results are not valid JSON',
    );
  });
});
