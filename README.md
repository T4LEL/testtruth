# testtruth

**All tests are green. That's exactly the problem.**

An agent is told to fix a bug. It changes the implementation *and* the tests.
CI goes green. The pull request gets merged.

Nobody checks whether the tests still test anything.

testtruth measures the strength of your test suite before and after a change —
using the same mutants on both sides — so a pull request that weakened the tests
cannot hide behind a green checkmark.

```
$ testtruth main..HEAD

testtruth  main..HEAD  a41f0c2..7d3b915

  CHANGED
  ──────────────────────────────────────────────────────────────────────
  source  src/auth/token.ts                              +8   -14
  tests   tests/token.test.js                            +6   -12

  MUTATION STRENGTH  14 mutants in the changed code
  ──────────────────────────────────────────────────────────────────────
  before this change  ████████████████░░░░  11/14 killed   79%
  after this change   ██████░░░░░░░░░░░░░░   4/14 killed   29%

  TEST STRENGTH   -50 points  ✗ the tests got weaker

  The suite is green, and it now notices 7 fewer broken behaviours than before.

  NEWLY SURVIVING MUTANTS  7 total
  ──────────────────────────────────────────────────────────────────────
  src/auth/token.ts:7     `true` → `false`      boolean literal
  src/auth/token.ts:8     `<=` → `<`            boundary comparison
  src/auth/token.ts:12    `0` → `null`          return value
  src/auth/token.ts:14    `/` → `*`             arithmetic
```

Seven ways to break that code that the old tests caught and the new tests do
not. Every one of them still passes CI.

---

## See it in 60 seconds

```bash
git clone https://github.com/T4LEL/testtruth && cd testtruth
npm install && npm run build
npm run demo
```

`examples/` generates a two-commit repository whose second commit is exactly the
pull request above: the source is refactored without changing behaviour, and the
tests are quietly replaced with `assert.equal(typeof result, 'boolean')`. Both
commits are fully green. Only the mutation score moves.

## Use it on a real change

```bash
npx testtruth                       # HEAD~1..HEAD
npx testtruth main..HEAD
npx testtruth origin/main...HEAD    # merge-base, like a pull request
npx testtruth abc1234               # one commit against its parent
```

Point it at your suite if `npm test` is not right:

```bash
npx testtruth --test-cmd "npx vitest run"
npx testtruth --test-cmd "npx vitest run {tests}"   # only the changed test files
```

## What it actually does

1. Read the diff with `--unified=0`, so it knows the exact lines that changed.
2. Parse the changed source files with the **TypeScript compiler's own parser**
   and generate mutants from expressions on those lines only.
3. Check the suite is green before touching anything.
4. Score every mutant against the tests **as they are now**.
5. Swap the changed test files back to their base-revision content and score
   **the same mutants again**.
6. Report the difference.

Step 5 is the whole point. Because the mutants are identical on both sides and
only the test files moved, the delta is attributable to the test change and
nothing else.

## Why the parser matters

The naive way to build a mutation tool is a regex over the source. It cannot
tell `a < b` from `Array<string>`, so it emits mutants that do not compile.
Those make the suite error out — which scores as *killed*. Enough of them and
every test suite looks strong, which is precisely backwards.

testtruth generates mutants from the AST, and has a property test asserting
every mutant it can produce still parses, in both `.ts` and `.tsx`.

## Mutation operators

| Category | Mutation |
| --- | --- |
| Boundary | `<` ↔ `<=`, `>` ↔ `>=` |
| Equality | `===` ↔ `!==`, `==` ↔ `!=` |
| Logic | `&&` ↔ `\|\|`, `??` → `\|\|`, `!x` → `x` |
| Arithmetic | `+` ↔ `-`, `*` ↔ `/`, `%` → `*` |
| Literals | `true` ↔ `false`, `0` ↔ `1`, `n` → `n+1` |
| Return | `return expr` → `return null` |

Enum members and type-level literals are skipped — they are not runtime
behaviour.

## Use it in CI

```yaml
- run: npx testtruth origin/${{ github.base_ref }}...HEAD --fail-under 10
```

Exits `1` when test strength drops by more than the given number of points. A
refactor that genuinely removes redundant assertions will drift a few points; a
pull request that gutted the suite will not.

## Safety

testtruth edits files in your working tree, because that is the only place your
project's own test command reliably runs — `node_modules`, path aliases,
generated files and all.

So it is careful about it:

- **It refuses to start on a dirty working tree.** Commit or stash first, or
  pass `--allow-dirty` if you accept the risk.
- Every file is snapshotted before its first write and restored afterwards.
- The restore also runs on Ctrl+C and `SIGTERM`.
- It only ever writes to files that appear in the diff you asked about.

## Options

```
--test-cmd <cmd>     how to run the suite (default: npm test)
--max-mutants <n>    cap the mutant count (default: 30)
--timeout <sec>      per-run timeout (default: 120)
--limit <n>          survivors listed (default: 12)
--repo <dir>         repository root (default: .)
--fail-under <pts>   exit 1 if strength drops more than this
--allow-dirty        run despite uncommitted changes
--json               machine-readable result
--no-color           disable colour
```

`TESTTRUTH=1` and `CI=1` are set in the test command's environment.

## Honest limits

- **TypeScript and JavaScript only.** `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`,
  `.cjs`. Python and Go are not supported yet.
- **One suite run per mutant.** With the default cap of 30 mutants and a
  before/after comparison, that is up to 61 runs of your test command. Scope it
  with `--test-cmd "... {tests}"` if your suite is slow.
- **No before/after when the old tests cannot run.** If the change altered an
  API the base-revision tests called, they will not compile against the new
  source. testtruth says so and reports the after-side score alone rather than
  inventing a comparison.
- **Equivalent mutants exist.** Some surviving mutants are behaviourally
  identical to the original and no test could ever kill them. They are noise in
  the absolute number, but they appear on both sides, so they cancel out of the
  delta — which is the number this tool asks you to read.
- **A drop is a question, not a verdict.** Sometimes deleting a brittle
  assertion is right. testtruth makes the trade visible; the judgement is still
  yours.

## License

MIT
