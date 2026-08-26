const ESC = '\x1b[';

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  process.stdout.isTTY !== false;

const wrap = (open: number, close: number) => (s: string) =>
  enabled ? `${ESC}${open}m${s}${ESC}${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

const ANSI_RE = /\x1b\[\d+m/g;

/** Visible width, ignoring ANSI escapes. */
export function width(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

export function pad(s: string, n: number): string {
  const w = width(s);
  return w >= n ? s : s + ' '.repeat(n - w);
}

export function padStart(s: string, n: number): string {
  const w = width(s);
  return w >= n ? s : ' '.repeat(n - w) + s;
}

/** Colour a 0-100 score: green good, yellow middling, red bad. */
export function scoreColor(score: number): (s: string) => string {
  if (score >= 70) return green;
  if (score >= 40) return yellow;
  return red;
}

/** Solid block bar, 0-100 mapped onto `cells` characters. */
export function bar(score: number, cells = 16): string {
  const clamped = Math.max(0, Math.min(100, score));
  const filled = Math.round((clamped / 100) * cells);
  return scoreColor(score)('█'.repeat(filled)) + gray('░'.repeat(cells - filled));
}

export function rule(char = '─', n = 64): string {
  return gray(char.repeat(n));
}
