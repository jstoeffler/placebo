/**
 * Error convention for all of core.
 *
 * - Expected failures that a caller must handle (invalid suite, missing file, bad user input)
 *   are returned as a `Result`, never thrown.
 * - Infrastructure failures (a process that cannot spawn, a rate limit, a full disk) are thrown
 *   as typed errors such as `RunnerInfraError`, because the caller can only retry or abort.
 * - Anything else that throws is a bug.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}
