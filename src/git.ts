import { execFileSync } from 'node:child_process';

export interface ChangedFile {
  path: string;
  /** 1-based line numbers added or modified on the head side. */
  lines: Set<number>;
  added: number;
  removed: number;
  /** True when the file did not exist at the base revision. */
  isNew: boolean;
}

export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd).trim();
}

export function resolveRange(range: string, cwd: string): { base: string; head: string } {
  const dots = range.includes('...') ? '...' : range.includes('..') ? '..' : null;
  if (!dots) {
    // A single revision means "this commit against its parent".
    const head = git(['rev-parse', range], cwd).trim();
    const base = git(['rev-parse', `${range}^`], cwd).trim();
    return { base, head };
  }

  const [left, right] = range.split(dots);
  const headRef = right?.trim() || 'HEAD';
  const baseRef = left?.trim() || 'HEAD';
  const base =
    dots === '...'
      ? git(['merge-base', baseRef, headRef], cwd).trim()
      : git(['rev-parse', baseRef], cwd).trim();
  return { base, head: git(['rev-parse', headRef], cwd).trim() };
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Changed files with their head-side line numbers.
 *
 * `--unified=0` is deliberate: with no context lines, every hunk header
 * describes exactly the lines that changed, which is the set worth mutating.
 */
export function changedFiles(base: string, head: string, cwd: string): ChangedFile[] {
  const diff = git(
    ['diff', '--unified=0', '--no-color', '--no-renames', `${base}..${head}`],
    cwd,
  );

  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '').trim();
      if (path === '/dev/null') {
        current = null;
        continue;
      }
      current = { path, lines: new Set(), added: 0, removed: 0, isNew: false };
      files.push(current);
      continue;
    }
    if (line.startsWith('--- ') && current) {
      current.isNew = line.slice(4).trim() === '/dev/null';
      continue;
    }
    if (!current) continue;

    const hunk = line.match(HUNK);
    if (hunk) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) current.lines.add(start + i);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) current.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed++;
  }

  return files;
}

export function fileAtRevision(rev: string, path: string, cwd: string): string | null {
  return tryGit(['show', `${rev}:${path}`], cwd);
}

export function isTreeClean(cwd: string): boolean {
  return git(['status', '--porcelain'], cwd).trim() === '';
}

export function dirtyPaths(cwd: string): string[] {
  return git(['status', '--porcelain'], cwd)
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

const TEST_PATTERN =
  /(\.(test|spec)\.[^.]+$|(^|\/)(tests?|__tests__|spec|e2e|cypress)(\/|$))/;

export function looksLikeTest(path: string): boolean {
  return TEST_PATTERN.test(path);
}
