import { RESULTS_SCHEMA_VERSION } from '@placebo-eval/core/results';
import { useEffect, useMemo, useState } from 'react';
import { ReportProvider, useReport } from './context.js';
import type { Loaded } from './data/load.js';
import { buildIndex } from './data/model.js';
import { formatTimestamp } from './format.js';
import { toHash, useRoute, type Route } from './route.js';
import { ReviewApp } from './review/ReviewApp.js';
import { Agreement } from './views/Agreement.js';
import { Frame, Message } from './views/Frame.js';
import { Pins } from './views/Pins.js';
import { RunDetail } from './views/RunDetail.js';
import { RunList } from './views/RunList.js';
import { TaskBreakdown } from './views/TaskBreakdown.js';
import { VerdictCard } from './views/VerdictCard.js';
import { Warnings } from './views/Warnings.js';

export function App(props: { readonly loaded: Loaded }) {
  // Review mode swaps in the full results once the reviewer finishes the pass.
  const [loaded, setLoaded] = useState(props.loaded);
  switch (loaded.state) {
    case 'absent':
      return (
        <Frame>
          <Message title="No results in this report">
            <p>
              This is the empty report template. Run <code>placebo run</code> in a repository with a{' '}
              <code>.placebo/</code> suite, or <code>placebo report</code> to rebuild the report
              from the run store; both write a <code>report.html</code> with the results inside.
            </p>
          </Message>
        </Frame>
      );
    case 'unsupported':
      return (
        <Frame>
          <Message title="This report cannot read these results" alert>
            <p>
              The results use schema version {JSON.stringify(loaded.version)}, and this report reads
              version {RESULTS_SCHEMA_VERSION}. Rebuild the report with the placebo version that
              wrote the results: <code>placebo report</code>.
            </p>
          </Message>
        </Frame>
      );
    case 'invalid':
      return (
        <Frame>
          <Message title="The embedded results are damaged" alert>
            <p>
              {loaded.path === undefined ? (
                <>Cannot read the results: {loaded.reason}.</>
              ) : (
                <>
                  The first problem is at <code>{loaded.path}</code>: {loaded.reason}.
                </>
              )}{' '}
              Rebuild the report from the run store with <code>placebo report</code>.
            </p>
          </Message>
        </Frame>
      );
    case 'loaded':
      return <Loaded loaded={loaded} />;
    case 'review':
      return (
        <ReviewApp
          session={loaded.session}
          onFinished={(results) => {
            setLoaded({ state: 'loaded', results, mode: 'report' });
          }}
        />
      );
  }
}

function Loaded({ loaded }: { readonly loaded: Extract<Loaded, { state: 'loaded' }> }) {
  const index = useMemo(() => buildIndex(loaded.results), [loaded.results]);
  return (
    <ReportProvider index={index} mode={loaded.mode}>
      <Report />
    </ReportProvider>
  );
}

function Report() {
  const route = useRoute();
  const { index } = useReport();
  const { experiment } = index.results;
  useEffect(() => {
    if (route.view !== 'run') window.scrollTo({ top: 0 });
  }, [route.view]);
  return (
    <Frame
      nav={<Nav route={route} />}
      meta={
        <>
          <span className="code">{experiment.id}</span>
          <span>{formatTimestamp(experiment.createdAt)}</span>
        </>
      }
    >
      <View route={route} />
    </Frame>
  );
}

function View({ route }: { readonly route: Route }) {
  const { index } = useReport();
  const { results } = index;
  switch (route.view) {
    case 'overview':
      return (
        <>
          <Warnings warnings={results.warnings} />
          <div className="cards">
            {results.verdictCards.map((card) => (
              <VerdictCard key={card.variant} card={card} results={results} />
            ))}
          </div>
          <p className="legend">
            Each difference is treatment minus control, per task, then summarized across tasks. The
            range is its plausible spread by resampling. Each line is drawn on its own scale: the
            tick is zero and the shaded band is the margin, the smallest difference that would
            matter.
          </p>
          {results.agreement !== undefined && <Agreement agreement={results.agreement} />}
          <Pins experiment={results.experiment} />
        </>
      );
    case 'tasks':
      return <TaskBreakdown />;
    case 'runs':
      return <RunList filter={route.filter} />;
    case 'run':
      return <RunDetail runId={route.runId} filter={route.filter} />;
  }
}

function Nav({ route }: { readonly route: Route }) {
  const current = route.view === 'run' ? 'runs' : route.view;
  const links: [Route['view'], string, string][] = [
    ['overview', 'Verdicts', toHash({ view: 'overview' })],
    ['tasks', 'Tasks', toHash({ view: 'tasks' })],
    ['runs', 'Runs', toHash({ view: 'runs', filter: {} })],
  ];
  return (
    <nav aria-label="Report">
      <ul className="tabs">
        {links.map(([view, label, href]) => (
          <li key={view}>
            <a href={href} aria-current={current === view ? 'page' : undefined}>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
