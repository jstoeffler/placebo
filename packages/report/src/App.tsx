import type { Embedded } from './embedded.js';

export function App({ embedded }: { readonly embedded: Embedded }) {
  switch (embedded.state) {
    case 'absent':
      return <p>No results embedded</p>;
    case 'invalid':
      return <p role="alert">Cannot read results: {embedded.reason}</p>;
    case 'loaded':
      return (
        <dl>
          <dt>Experiment</dt>
          <dd>{embedded.results.experiment.id}</dd>
          <dt>Schema version</dt>
          <dd>{embedded.results.schemaVersion}</dd>
        </dl>
      );
  }
}
