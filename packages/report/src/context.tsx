import { createContext, useContext, type ReactNode } from 'react';
import type { ReportMode } from './data/load.js';
import type { Index } from './data/model.js';

interface ReportContextValue {
  readonly index: Index;
  readonly mode: ReportMode;
}

const ReportContext = createContext<ReportContextValue | null>(null);

export function ReportProvider(props: ReportContextValue & { readonly children: ReactNode }) {
  return (
    <ReportContext value={{ index: props.index, mode: props.mode }}>{props.children}</ReportContext>
  );
}

export function useReport(): ReportContextValue {
  const value = useContext(ReportContext);
  if (value === null) throw new Error('useReport outside ReportProvider');
  return value;
}

/**
 * Every arm name in the report goes through here, so review mode can hide which arm a run
 * belongs to (blinding) in one place.
 */
export function ArmLabel({ name }: { readonly name: string }) {
  const { mode } = useReport();
  if (mode === 'review') return <span className="arm arm-hidden">hidden arm</span>;
  return <span className={name === 'control' ? 'arm arm-control' : 'arm'}>{name}</span>;
}
