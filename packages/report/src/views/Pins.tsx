import type { Experiment } from '@placebo-eval/core/results';
import { useState } from 'react';
import { formatTimestamp } from '../format.js';

interface Pin {
  readonly label: string;
  readonly value: string;
  readonly code?: boolean;
}

function pinList(experiment: Experiment): Pin[] {
  const { pins } = experiment;
  return [
    { label: 'Commit', value: pins.commit, code: true },
    { label: 'Subject model', value: pins.subjectModel },
    { label: 'Judge model', value: pins.judgeModel },
    { label: 'Claude Code', value: pins.claudeCodeVersion },
    { label: 'Suite hash', value: pins.suiteHash, code: true },
    { label: 'Placebo', value: pins.placeboVersion },
    { label: 'Seed', value: String(experiment.seed), code: true },
    { label: 'Created', value: formatTimestamp(experiment.createdAt) },
  ];
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function Pins({ experiment }: { readonly experiment: Experiment }) {
  const pins = pinList(experiment);
  const [status, setStatus] = useState('');
  const onCopy = (label: string, text: string) => {
    void copy(text).then((ok) => {
      setStatus(ok ? `Copied ${label}.` : 'Copy is not available here; select the text instead.');
    });
  };
  const all = pins.map((pin) => `${pin.label}: ${pin.value}`).join('\n');
  return (
    <section className="pins" aria-labelledby="pins-heading">
      <div className="section-head">
        <h2 id="pins-heading">Pins</h2>
        <button
          type="button"
          className="button"
          onClick={() => {
            onCopy('all pins', all);
          }}
        >
          Copy all pins
        </button>
      </div>
      <p className="quiet">These values must match for another report to be comparable.</p>
      <dl className="pin-list">
        {pins.map((pin) => (
          <div key={pin.label} className="pin">
            <dt>{pin.label}</dt>
            <dd>
              <span className={pin.code === true ? 'code selectable' : 'selectable'}>
                {pin.value}
              </span>
              <button
                type="button"
                className="link-button"
                aria-label={`Copy ${pin.label.toLowerCase()}`}
                onClick={() => {
                  onCopy(pin.label.toLowerCase(), pin.value);
                }}
              >
                Copy
              </button>
            </dd>
          </div>
        ))}
      </dl>
      <p className="status" role="status">
        {status}
      </p>
    </section>
  );
}
