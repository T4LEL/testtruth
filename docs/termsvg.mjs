#!/usr/bin/env node
/**
 * termsvg — run a command, capture its ANSI output, emit an animated SVG.
 *
 * Produces a self-contained SVG that GitHub renders inside a README.
 *
 * Deliberately static. GitHub serves SVGs through an <img> proxy where the
 * animation timeline is not guaranteed to advance, and a reveal animation that
 * never starts leaves an empty black rectangle. A static render is sharp at any
 * DPI, needs no fallback, and is a tenth the size of an equivalent GIF.
 *
 *   node termsvg.mjs --cwd DIR --out FILE.svg --title "$ cmd" -- <command...>
 *
 * Options:
 *   --lines a:b     keep only output lines [a, b) after capture
 *   --drop RE       drop captured lines matching this regular expression
 *   --cols N        force a terminal width          (default 96)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const split = argv.indexOf('--');
if (split === -1) {
  process.stderr.write('termsvg: missing "--" before the command\n');
  process.exit(1);
}
const flags = new Map();
for (let i = 0; i < split; i++) {
  if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[++i]);
}
const command = argv.slice(split + 1);

const cwd = resolve(flags.get('cwd') ?? process.cwd());
const out = resolve(flags.get('out') ?? 'demo.svg');
const title = flags.get('title') ?? `$ ${command.join(' ')}`;
const cols = Number(flags.get('cols') ?? 96);

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------
// NO_COLOR must be absent, not empty: the spec treats any non-empty value as
// "disable colour", and an empty one as unset.
const childEnv = { ...process.env, FORCE_COLOR: '1', COLUMNS: String(cols) };
delete childEnv.NO_COLOR;

const result = spawnSync(command[0], command.slice(1), {
  cwd,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  env: childEnv,
});
if (result.error) {
  process.stderr.write(`termsvg: ${result.error.message}\n`);
  process.exit(1);
}

let lines = `${result.stdout ?? ''}${result.stderr ?? ''}`
  .replace(/\r/g, '')
  .split('\n');

if (flags.has('drop')) {
  const re = new RegExp(flags.get('drop'));
  lines = lines.filter((l) => !re.test(stripAnsi(l)));
}
if (flags.has('lines')) {
  const [a, b] = flags.get('lines').split(':').map(Number);
  lines = lines.slice(a || 0, Number.isFinite(b) ? b : undefined);
}
while (lines.length && !stripAnsi(lines.at(-1)).trim()) lines.pop();
while (lines.length && !stripAnsi(lines[0]).trim()) lines.shift();

// ---------------------------------------------------------------------------
// ANSI -> styled spans
// ---------------------------------------------------------------------------
const PALETTE = {
  30: '#484f58', 31: '#ff7b72', 32: '#7ee787', 33: '#e3b341',
  34: '#79c0ff', 35: '#d2a8ff', 36: '#56d4dd', 37: '#c9d1d9',
  90: '#8b949e', 91: '#ffa198', 92: '#aff5b4', 93: '#f2cc60',
  94: '#a5d6ff', 95: '#e2c5ff', 96: '#b3f0ff', 97: '#f0f6fc',
};
const FG_DEFAULT = '#c9d1d9';

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function xml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Split one line into runs of identical styling. */
function parseLine(line) {
  const runs = [];
  let state = { fill: FG_DEFAULT, bold: false, dim: false };
  let buffer = '';

  const flush = () => {
    if (buffer) runs.push({ text: buffer, ...state });
    buffer = '';
  };

  const pattern = /\x1b\[([0-9;]*)m/g;
  let cursor = 0;
  for (let m = pattern.exec(line); m; m = pattern.exec(line)) {
    buffer += line.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    flush();
    state = { ...state };
    for (const raw of m[1].split(';')) {
      const code = Number(raw || '0');
      if (code === 0) state = { fill: FG_DEFAULT, bold: false, dim: false };
      else if (code === 1) state.bold = true;
      else if (code === 2) state.dim = true;
      else if (code === 22) { state.bold = false; state.dim = false; }
      else if (code === 39) state.fill = FG_DEFAULT;
      else if (PALETTE[code]) state.fill = PALETTE[code];
    }
  }
  buffer += line.slice(cursor);
  flush();
  return runs;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
const FONT_SIZE = 14;
const CHAR_W = FONT_SIZE * 0.6; // monospace advance for the chosen stack
const LINE_H = 21;
const PAD_X = 20;
const PAD_Y = 16;
const CHROME_H = 38;

const widestLine = lines.reduce((n, l) => Math.max(n, stripAnsi(l).length), 0);
const width = Math.ceil(Math.max(widestLine, title.length + 4) * CHAR_W + PAD_X * 2);
const height = Math.ceil(CHROME_H + PAD_Y * 2 + lines.length * LINE_H);


// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------
const body = lines
  .map((line, i) => {
    const y = CHROME_H + PAD_Y + (i + 1) * LINE_H - 6;
    const runs = parseLine(line);
    if (runs.length === 0) return '';

    // Every chunk is positioned at its exact column. SVG collapses runs of
    // whitespace, which would silently destroy the padding that lines these
    // tables up, so gaps of two or more spaces become position rather than
    // text. Single spaces inside a chunk survive collapsing unchanged.
    const CHUNK = /[^ ](?:[^ ]| (?! ))*/g;
    let col = 0;
    const spans = [];

    for (const run of runs) {
      const weight = run.bold ? ' font-weight="600"' : '';
      const opacity = run.dim ? ' opacity="0.65"' : '';
      for (const match of run.text.matchAll(CHUNK)) {
        const x = PAD_X + (col + match.index) * CHAR_W;
        spans.push(
          `<tspan x="${x.toFixed(1)}" fill="${run.fill}"${weight}${opacity}>${xml(match[0])}</tspan>`,
        );
      }
      col += run.text.length;
    }

    if (spans.length === 0) return '';
    return `<text y="${y}">${spans.join('')}</text>`;
  })
  .join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="${FONT_SIZE}">
<rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>
<rect width="${width}" height="${CHROME_H}" rx="10" fill="#161b22"/>
<rect y="${CHROME_H - 10}" width="${width}" height="10" fill="#161b22"/>
<line x1="0" y1="${CHROME_H}" x2="${width}" y2="${CHROME_H}" stroke="#30363d" stroke-width="1"/>
<circle cx="20" cy="19" r="5.5" fill="#ff5f57"/>
<circle cx="39" cy="19" r="5.5" fill="#febc2e"/>
<circle cx="58" cy="19" r="5.5" fill="#28c840"/>
<text x="78" y="24" fill="#8b949e" font-size="12.5">${xml(title)}</text>
${body}
</svg>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, svg, 'utf8');
process.stdout.write(
  `${out}  ${width}x${height}  ${lines.length} lines  ${(svg.length / 1024).toFixed(1)} kB\n`,
);
