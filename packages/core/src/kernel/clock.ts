/** The only source of the current time in core; tests pass a fixed clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
