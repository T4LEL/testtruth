#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bold, cyan, gray, green, red, yellow } from './ansi.js';
import {
  changedFiles,
  dirtyPaths,
  fileAtRevision,
  looksLikeTest,
  repoRoot,
  resolveRange,
  type ChangedFile,
} from './git.js';
import { generateMutants, isSupported, type Mutant } from './mutate.js';
import {
  banner,
  changedBlock,
  hint,
  note,
  progress,
  strengthBlock,
  survivorBlock,
  verdictBlock,
  type Side,
} from './render.js';
import { runTests, scoreMutants, WorkingTree, type Outcome } from './run.js';

const VERSION = '0.1.0';

const HELP = `
${bold(cyan('testtruth'))} ${gray(VERSION)}  ${gray('— did the AI fix your code, or teach your tests to lie?')}

${bold('USAGE')}
  testtruth [<revision-range>] [options]

  ${gray('$')} testtruth                        ${gray('HEAD~1..HEAD')}
  ${gray('$')} testtruth main..HEAD
  ${gray('$')} testtruth origin/main...HEAD     ${gray('merge-base, like a pull request')}
  ${gray('$')} testtruth abc1234                ${gray('one commit against its parent')}

${bold('OPTIONS')}
  --test-cmd <cmd>     how to run the suite      ${gray('(default: npm test)')}
  --max-mutants <n>    cap the mutant count      ${gray('(default: 30)')}
  --timeout <sec>      per-run timeout           ${gray('(default: 120)')}
  --limit <n>          survivors listed          ${gray('(default: 12)')}
  --repo <dir>         repository root           ${gray('(default: .)')}
  --fail-under <pts>   exit 1 if strength drops more than this  ${gray('(for CI)')}
  --allow-dirty        run despite uncommitted changes ${gray('(not recommended)')}
  --json               machine-readable result
  --no-color           disable colour
  -h, --help           this message

${bold('WHAT IT MEASURES')}
  Mutants are generated only from the lines your diff touched, then scored twice:
  once against the tests as they are now, and once against the same tests as
  they were at the base revision. The difference is attributable to the test
  change alone.

  ${gray('{tests} in --test-cmd expands to the test files your diff touched:')}
  ${gray('$')} testtruth --test-cmd "npx vitest run {tests}"
`;

interface Args {
  range: string;
  repo: string;
  testCmd: string;
  maxMutants: number;
  timeout: number;
  limit: number;
  failUnder: number | null;
  allowDirty: boolean;
  json: boolean;
}

function fail(message: string): never {
  process.stderr.write(`${yellow('testtruth:')} ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const opts = new Map<string, string>();
  const flags = new Set<string>();
  const BOOLEAN = new Set(['allow-dirty', 'json', 'no-color']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN.has(key)) {
      flags.add(key);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) fail(`--${key} needs a value`);
    opts.set(key, value);
  }

  const num = (key: string, fallback: number): number => {
    const raw = opts.get(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) fail(`--${key} must be a positive number`);
    return n;
  };

  const failUnderRaw = opts.get('fail-under');

  return {
    range: positional[0] ?? 'HEAD~1..HEAD',
    repo: resolve(opts.get('repo') ?? process.cwd()),
    testCmd: opts.get('test-cmd') ?? 'npm test',
    maxMutants: Math.floor(num('max-mutants', 30)),
    timeout: num('timeout', 120),
    limit: Math.floor(num('limit', 12)),
    failUnder: failUnderRaw === undefined ? null : Math.abs(Number(failUnderRaw)),
    allowDirty: flags.has('allow-dirty'),
    json: flags.has('json'),
  };
}

/** Spread the cap across files so one huge file cannot crowd out the rest. */
function selectMutants(perFile: Map<string, Mutant[]>, cap: number): Mutant[] {
  const queues = [...perFile.values()].map((list) => [...list]);
  const picked: Mutant[] = [];
  let progressed = true;
  while (picked.length < cap && progressed) {
    progressed = false;
    for (const queue of queues) {
      if (picked.length >= cap) break;
      const next = queue.shift();
      if (next) {
        picked.push(next);
        progressed = true;
      }
    }
  }
  return picked.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (argv.includes('-v') || argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (argv.includes('--no-color')) process.env.NO_COLOR = '1';

  const args = parseArgs(argv);

  let root: string;
  try {
    root = repoRoot(args.repo);
  } catch {
    fail(`${args.repo} is not inside a git repository`);
  }

  if (!args.allowDirty) {
    const dirty = dirtyPaths(root);
    if (dirty.length > 0) {
      fail(
        `your working tree has uncommitted changes and testtruth edits files in place.\n` +
          `  Commit or stash first: ${dirty.slice(0, 3).join(', ')}` +
          `${dirty.length > 3 ? ` and ${dirty.length - 3} more` : ''}\n` +
          `  Override with --allow-dirty if you accept the risk.`,
      );
    }
  }

  let base: string;
  let head: string;
  try {
    ({ base, head } = resolveRange(args.range, root));
  } catch {
    fail(`could not resolve the revision range "${args.range}"`);
  }

  const changed = changedFiles(base, head, root);
  const sourceFiles = changed.filter((f) => isSupported(f.path) && !looksLikeTest(f.path));
  const testFiles = changed.filter((f) => looksLikeTest(f.path));

  process.stdout.write(banner(args.range, base, head));
  process.stdout.write(changedBlock(sourceFiles, testFiles));

  if (sourceFiles.length === 0) {
    process.stdout.write(
      note('no TypeScript or JavaScript source lines changed, so there is nothing to mutate.'),
    );
    return;
  }

  // --- build the mutant set from the changed lines only --------------------
  const perFile = new Map<string, Mutant[]>();
  let discovered = 0;
  for (const file of sourceFiles) {
    const full = join(root, file.path);
    if (!existsSync(full)) continue;
    const mutants = generateMutants(file.path, readFileSync(full, 'utf8'), file.lines);
    discovered += mutants.length;
    if (mutants.length) perFile.set(file.path, mutants);
  }

  const mutants = selectMutants(perFile, args.maxMutants);
  if (mutants.length === 0) {
    process.stdout.write(
      note('the changed lines contain no mutable expressions (comparisons, operators, literals).'),
    );
    return;
  }
  if (discovered > mutants.length) {
    process.stdout.write(
      note(`${discovered} mutants available, testing ${mutants.length} (--max-mutants).`),
    );
  }

  const cmd = { command: args.testCmd, cwd: root, timeoutMs: args.timeout * 1000 };
  const tree = new WorkingTree(root);

  try {
    // --- sanity: the suite must be green before anything is mutated --------
    process.stdout.write(`\n  ${gray('checking the suite is green before mutating…')}\n`);
    const sanity = runTests(cmd);
    if (!sanity.passed) {
      fail(
        `your test suite does not pass on ${head.slice(0, 7)}, so mutation scores would be meaningless.\n` +
          `  command: ${args.testCmd}\n` +
          `  ${lastLine(sanity.output)}`,
      );
    }

    // --- after: current tests ---------------------------------------------
    process.stdout.write(`  ${gray(`scoring ${mutants.length} mutants against the current tests`)}\n`);
    const afterRun = scoreMutants(mutants, tree, cmd, (i, outcome) =>
      process.stdout.write(`${progress('after', i, mutants.length, outcome)}\n`),
    );
    const after: Side = {
      label: 'after this change',
      killed: afterRun.killed,
      total: mutants.length,
    };

    // --- before: the same mutants, the old tests --------------------------
    let before: Side | null = null;
    let beforeOutcomes: Outcome[] = [];

    if (testFiles.length === 0) {
      process.stdout.write(
        `\n${note('no test files changed, so there is no before/after to compare.')}`,
      );
    } else {
      const restorable = restoreTestFilesToBase(tree, testFiles, base, root);
      if (restorable.length === 0) {
        process.stdout.write(
          `\n${note('every changed test file is new, so there is no earlier version to compare against.')}`,
        );
      } else {
        const oldSanity = runTests(cmd);
        if (!oldSanity.passed) {
          for (const f of restorable) tree.restore(f);
          process.stdout.write(
            `\n${note('the previous tests do not pass against the new source, so they cannot be compared.')}`,
          );
          process.stdout.write(
            hint('This usually means the change altered an API the old tests called.'),
          );
        } else {
          process.stdout.write(
            `\n  ${gray('scoring the same mutants against the previous tests')}\n`,
          );
          const beforeRun = scoreMutants(mutants, tree, cmd, (i, outcome) =>
            process.stdout.write(`${progress('before', i, mutants.length, outcome)}\n`),
          );
          beforeOutcomes = beforeRun.outcomes;
          before = {
            label: 'before this change',
            killed: beforeRun.killed,
            total: mutants.length,
          };
          for (const f of restorable) tree.restore(f);
        }
      }
    }

    // --- report ------------------------------------------------------------
    process.stdout.write(strengthBlock(before, after, mutants.length));

    const survivors = afterRun.outcomes
      .map((o, i) => (o === 'survived' ? i : -1))
      .filter((i) => i >= 0);

    let exitCode = 0;

    if (before) {
      process.stdout.write(verdictBlock(before, after));
      const newlySurviving = survivors.filter((i) => beforeOutcomes[i] !== 'survived');
      process.stdout.write(
        survivorBlock('NEWLY SURVIVING MUTANTS', mutants, newlySurviving, args.limit),
      );
      if (newlySurviving.length === 0 && survivors.length > 0) {
        process.stdout.write(
          survivorBlock('SURVIVING MUTANTS (unchanged from before)', mutants, survivors, args.limit),
        );
      }
      const drop = (before.killed - after.killed) / mutants.length * 100;
      if (args.failUnder !== null && drop > args.failUnder) {
        process.stdout.write(
          `  ${red(bold('FAIL'))} ${gray(`strength dropped ${Math.round(drop * 10) / 10} points, limit is ${args.failUnder}`)}\n\n`,
        );
        exitCode = 1;
      }
    } else {
      process.stdout.write(
        survivorBlock('SURVIVING MUTANTS', mutants, survivors, args.limit),
      );
      if (survivors.length === 0) {
        process.stdout.write(
          `  ${green('Every mutant was killed.')} ${gray('The changed lines are well covered.')}\n\n`,
        );
      }
    }

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            range: args.range,
            base,
            head,
            mutants: mutants.length,
            after,
            before,
            survivors: survivors.map((i) => mutants[i]),
          },
          null,
          2,
        )}\n`,
      );
    }

    if (exitCode !== 0) process.exitCode = exitCode;
  } finally {
    tree.restoreAll();
  }
}

/** Swap changed test files back to their base-revision content. */
function restoreTestFilesToBase(
  tree: WorkingTree,
  testFiles: ChangedFile[],
  base: string,
  root: string,
): string[] {
  const swapped: string[] = [];
  for (const file of testFiles) {
    const old = fileAtRevision(base, file.path, root);
    if (old === null) continue;
    tree.write(file.path, old);
    swapped.push(file.path);
  }
  return swapped;
}

function lastLine(output: string): string {
  const lines = output.trim().split('\n').filter((l) => l.trim());
  return lines.at(-1)?.trim().slice(0, 200) ?? '(no output)';
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
