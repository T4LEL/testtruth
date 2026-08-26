#!/usr/bin/env node
/**
 * `npm run demo` — regenerate examples/green-pr and run testtruth against it.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const demo = join(here, 'green-pr');

const make = spawnSync(process.execPath, [join(here, 'make-demo-repo.mjs')], {
  stdio: 'inherit',
});
if (make.status !== 0) process.exit(make.status ?? 1);

const run = spawnSync(
  process.execPath,
  [
    join(root, 'dist', 'cli.js'),
    '--repo',
    demo,
    '--test-cmd',
    'node --experimental-strip-types --disable-warning=ExperimentalWarning tests/token.test.js',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);

process.exit(run.status ?? 1);
