import {
  bar,
  bold,
  cyan,
  dim,
  gray,
  green,
  pad,
  padStart,
  red,
  rule as hline,
  yellow,
} from './ansi.js';
import type { ChangedFile } from './git.js';
import { describe, type Mutant } from './mutate.js';
import type { Outcome } from './run.js';

export function termWidth(): number {
  return Math.max(64, Math.min(process.stdout.columns || 100, 110));
}

export function banner(range: string, base: string, head: string): string {
  return (
    `\n${bold(cyan('testtruth'))}  ${bold(range)}  ` +
    `${gray(`${base.slice(0, 7)}..${head.slice(0, 7)}`)}\n`
  );
}

export function changedBlock(source: ChangedFile[], tests: ChangedFile[]): string {
  const out: string[] = [''];
  const width = termWidth();
  out.push(`  ${bold('CHANGED')}`);
  out.push(`  ${hline('─', width - 4)}`);

  const row = (label: string, f: ChangedFile) =>
    `  ${gray(pad(label, 8))}${pad(f.path, width - 30)}` +
    `${green(padStart(`+${f.added}`, 6))} ${red(padStart(`-${f.removed}`, 5))}`;

  for (const f of source) out.push(row('source', f));
  for (const f of tests) out.push(row('tests', f));
  if (tests.length === 0) {
    out.push(`  ${gray('tests')}   ${yellow('no test files were changed')}`);
  }
  out.push('');
  return out.join('\n');
}

export interface Side {
  label: string;
  killed: number;
  total: number;
}

export function strengthBlock(before: Side | null, after: Side, mutants: number): string {
  const out: string[] = [''];
  const width = termWidth();

  out.push(
    `  ${bold('MUTATION STRENGTH')}  ${gray(`${mutants} mutants in the changed code`)}`,
  );
  out.push(`  ${hline('─', width - 4)}`);

  const line = (side: Side) => {
    const rate = side.total === 0 ? 0 : side.killed / side.total;
    return (
      `  ${pad(side.label, 20)}${bar(rate * 100, 20)}` +
      `  ${gray(`${side.killed}/${side.total} killed`)}` +
      `  ${bold(padStart(`${Math.round(rate * 100)}%`, 4))}`
    );
  };

  if (before) out.push(line(before));
  out.push(line(after));
  out.push('');
  return out.join('\n');
}

/** Middle-elides so both the operator and its replacement stay visible. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

export function verdictBlock(before: Side, after: Side): string {
  const beforeRate = before.total ? before.killed / before.total : 0;
  const afterRate = after.total ? after.killed / after.total : 0;
  const delta = (afterRate - beforeRate) * 100;
  const rounded = Math.round(delta * 10) / 10;

  const out: string[] = [''];
  if (rounded <= -5) {
    out.push(
      `  ${bold(red('TEST STRENGTH'))}   ${bold(red(`${rounded} points`))}  ` +
        `${red('✗')} ${gray('the tests got weaker')}`,
    );
    out.push('');
    out.push(
      `  ${gray('The suite is green, and it now notices')} ` +
        `${bold(String(before.killed - after.killed))} ${gray('fewer broken behaviours than before.')}`,
    );
  } else if (rounded >= 5) {
    out.push(
      `  ${bold(green('TEST STRENGTH'))}   ${bold(green(`+${rounded} points`))}  ` +
        `${green('✓')} ${gray('the tests got stronger')}`,
    );
  } else {
    out.push(
      `  ${bold('TEST STRENGTH')}   ${bold(`${rounded >= 0 ? '+' : ''}${rounded} points`)}  ` +
        `${gray('no meaningful change')}`,
    );
  }
  out.push('');
  return out.join('\n');
}

export function survivorBlock(
  title: string,
  mutants: Mutant[],
  indices: number[],
  limit: number,
): string {
  if (indices.length === 0) return '';
  const width = termWidth();
  const out: string[] = [''];
  out.push(`  ${bold(title)}  ${gray(`${indices.length} total`)}`);
  out.push(`  ${hline('─', width - 4)}`);

  const kindWidth = 20;
  const changeWidth = 28;
  const whereWidth = Math.max(20, width - kindWidth - changeWidth - 6);

  for (const i of indices.slice(0, limit)) {
    const m = mutants[i]!;
    const where = truncate(`${m.file}:${m.line}`, whereWidth - 2);
    const change = truncate(describe(m), changeWidth - 2);
    out.push(`  ${pad(where, whereWidth)}${pad(change, changeWidth)}${gray(m.kind)}`);
  }
  if (indices.length > limit) {
    out.push(`  ${gray(`… and ${indices.length - limit} more`)}`);
  }
  out.push('');
  return out.join('\n');
}

export function progress(
  phase: string,
  index: number,
  total: number,
  outcome: Outcome,
): string {
  const mark =
    outcome === 'survived' ? red('✗ survived') : outcome === 'timeout' ? yellow('⏱ timeout') : green('✓ killed');
  return `  ${gray(pad(phase, 8))}${gray(padStart(`${index + 1}/${total}`, 7))}  ${mark}`;
}

export function note(text: string): string {
  return `  ${yellow('⚠')} ${gray(text)}\n`;
}

export function hint(text: string): string {
  return `  ${dim(text)}\n`;
}
