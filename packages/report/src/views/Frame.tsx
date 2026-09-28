import type { ReactNode } from 'react';

/** The page around every view: skip link, masthead with optional meta and navigation, main. */
export function Frame(props: {
  readonly children: ReactNode;
  readonly nav?: ReactNode;
  readonly meta?: ReactNode;
}) {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="masthead">
        <div className="masthead-inner">
          <p className="wordmark">Placebo</p>
          {props.meta !== undefined && <p className="masthead-meta">{props.meta}</p>}
          {props.nav}
        </div>
      </header>
      <main id="main" className="page">
        {props.children}
      </main>
    </>
  );
}

export function Message(props: {
  readonly title: string;
  readonly alert?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section className="message" role={props.alert === true ? 'alert' : undefined}>
      <h1>{props.title}</h1>
      {props.children}
    </section>
  );
}
