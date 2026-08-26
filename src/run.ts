import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyMutant, type Mutant } from './mutate.js';

export type Outcome = 'killed' | 'survived' | 'timeout';

/**
 * Edits are made to the real working tree, because that is the only place the
 * project's own test command is guaranteed to run — node_modules, path
 * aliases, generated files and all.
 *
 * Every file is snapshotted before its first write and restored afterwards,
 * including on Ctrl+C. testtruth refuses to start on a dirty tree so a failed
 * restore can never destroy uncommitted work.
 */
export class WorkingTree {
  private originals = new Map<string, string>();
  private detach: (() => void) | null = null;

  constructor(private root: string) {
    this.armSignalHandlers();
  }

  write(relPath: string, content: string): void {
    const full = join(this.root, relPath);
    if (!this.originals.has(relPath)) {
      this.originals.set(relPath, readFileSync(full, 'utf8'));
    }
    writeFileSync(full, content, 'utf8');
  }

  read(relPath: string): string {
    return this.originals.get(relPath) ?? readFileSync(join(this.root, relPath), 'utf8');
  }

  /** Restore one file to the content it had when testtruth started. */
  restore(relPath: string): void {
    const original = this.originals.get(relPath);
    if (original === undefined) return;
    writeFileSync(join(this.root, relPath), original, 'utf8');
  }

  restoreAll(): void {
    for (const relPath of this.originals.keys()) this.restore(relPath);
    this.detach?.();
    this.detach = null;
  }

  private armSignalHandlers(): void {
    const handler = (signal: NodeJS.Signals) => () => {
      this.restoreAll();
      process.stderr.write(`\ntesttruth: restored your working tree after ${signal}\n`);
      process.exit(130);
    };
    const onInt = handler('SIGINT');
    const onTerm = handler('SIGTERM');
    process.once('SIGINT', onInt);
    process.once('SIGTERM', onTerm);
    this.detach = () => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
    };
  }
}

export interface TestCommand {
  command: string;
  cwd: string;
  timeoutMs: number;
}

export function runTests(cmd: TestCommand): { passed: boolean; timedOut: boolean; output: string } {
  const result = spawnSync(cmd.command, {
    cwd: cmd.cwd,
    shell: true,
    encoding: 'utf8',
    timeout: cmd.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TESTTRUTH: '1', CI: '1', FORCE_COLOR: '0' },
  });
  const timedOut = result.signal === 'SIGTERM' || Boolean(result.error);
  return {
    passed: !timedOut && result.status === 0,
    timedOut,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

export interface MutationRun {
  /** Mutant index -> what happened to it. */
  outcomes: Outcome[];
  killed: number;
  survived: number;
}

/**
 * Score a set of mutants against whatever tests are currently on disk.
 * A mutant is killed when the suite fails, i.e. the tests noticed the change.
 */
export function scoreMutants(
  mutants: Mutant[],
  tree: WorkingTree,
  cmd: TestCommand,
  onProgress?: (index: number, outcome: Outcome) => void,
): MutationRun {
  const outcomes: Outcome[] = [];
  const pristine = new Map<string, string>();
  for (const m of mutants) {
    if (!pristine.has(m.file)) pristine.set(m.file, tree.read(m.file));
  }

  for (let i = 0; i < mutants.length; i++) {
    const mutant = mutants[i]!;
    const source = pristine.get(mutant.file)!;
    tree.write(mutant.file, applyMutant(source, mutant));

    const result = runTests(cmd);
    const outcome: Outcome = result.timedOut
      ? 'timeout'
      : result.passed
        ? 'survived'
        : 'killed';
    outcomes.push(outcome);
    onProgress?.(i, outcome);

    // Put the file back before touching the next mutant, so mutants never stack.
    tree.write(mutant.file, source);
  }

  return {
    outcomes,
    // A mutant that hangs the suite has changed observable behaviour, which is
    // what "killed" means. It is reported separately so it can be audited.
    killed: outcomes.filter((o) => o !== 'survived').length,
    survived: outcomes.filter((o) => o === 'survived').length,
  };
}
