import pc from 'picocolors';

export type Colors = ReturnType<typeof pc.createColors>;

/**
 * Colours for one output stream: on only for a terminal, and never with `--no-color` or a
 * non-empty `NO_COLOR` (https://no-color.org).
 */
export function colorsFor(
  isTTY: boolean,
  color: boolean,
  env: Readonly<Record<string, string | undefined>>,
): Colors {
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  return pc.createColors(isTTY && color && !noColor);
}
