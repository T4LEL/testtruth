#!/usr/bin/env node
/**
 * Run every compiled test file.
 *
 * `node --test` only understands glob patterns from Node 22, and shell globs
 * do not expand on Windows where npm runs scripts through cmd.exe. Listing the
 * files explicitly is the one approach that works on every supported runtime.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join('.tmp-test', 'tests');

let files;
try {
  files = readdirSync(dir, { recursive: true })
    .filter((name) => String(name).endsWith('.test.js'))
    .map((name) => join(dir, String(name)));
} catch {
  process.stderr.write(`no compiled tests in ${dir} - did the build step run?\n`);
  process.exit(1);
}

if (files.length === 0) {
  process.stderr.write(`no *.test.js files found in ${dir}\n`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
