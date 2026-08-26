import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { applyMutant, describe, generateMutants, isSupported } from '../src/mutate.js';

function mutantsFor(code: string, file = 'sample.ts', lines?: Set<number>) {
  return generateMutants(file, code, lines);
}

/** Every mutant must still parse, or it scores as "killed" for the wrong reason. */
function assertAllParse(code: string, file = 'sample.ts') {
  for (const mutant of mutantsFor(code, file)) {
    const mutated = applyMutant(code, mutant);
    const source = ts.createSourceFile(file, mutated, ts.ScriptTarget.Latest, true);
    const diagnostics = (source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics;
    assert.equal(
      diagnostics.length,
      0,
      `mutant ${describe(mutant)} at line ${mutant.line} produced invalid syntax:\n${mutated}`,
    );
  }
}

test('mutates comparison operators in both directions', () => {
  const found = mutantsFor('const a = x < y;').map(describe);
  assert.deepEqual(found, ['`<` → `<=`']);
  assert.deepEqual(mutantsFor('const a = x >= y;').map(describe), ['`>=` → `>`']);
});

test('does not mutate generic type arguments', () => {
  const code = 'const list: Array<string> = [];\nfunction f<T>(x: T): T { return x; }';
  const found = mutantsFor(code).map(describe);
  assert.deepEqual(found.filter((d) => d.includes('<')), []);
});

test('does not mutate arrow functions into comparisons', () => {
  const code = 'const f = (a: number) => a;';
  assert.deepEqual(mutantsFor(code).map(describe), []);
});

test('leaves string and comment contents alone', () => {
  const code = `// a < b && c\nconst s = "x < y && z";\nconst t = \`a === b\`;`;
  assert.deepEqual(mutantsFor(code), []);
});

test('every generated mutant is still valid syntax', () => {
  assertAllParse(`
    export function classify(n: number, flag: boolean): string {
      const list: Array<string> = [];
      const scaled = n * 2 + 1;
      if (!flag && scaled >= 10) return 'high';
      if (scaled === 0 || scaled < -1) return 'low';
      return list.length > 0 ? 'some' : 'none';
    }
  `);
});

test('every generated mutant in TSX is still valid syntax', () => {
  assertAllParse(
    `export const B = ({ n }: { n: number }) => (n > 1 ? <b>many</b> : <i>one</i>);`,
    'sample.tsx',
  );
});

test('numeric constants become off-by-one, and 0/1 swap', () => {
  const found = mutantsFor('const a = 0; const b = 1; const c = 7;').map(describe);
  assert.deepEqual(found, ['`0` → `1`', '`1` → `0`', '`7` → `8`']);
});

test('floats and hex are left alone, since off-by-one is meaningless there', () => {
  assert.deepEqual(mutantsFor('const a = 1.5; const b = 0xff;').map(describe), []);
});

test('enum members are not mutated', () => {
  assert.deepEqual(mutantsFor('enum E { A = 1, B = 2 }').map(describe), []);
});

test('return values are replaced with null', () => {
  const found = mutantsFor('function f() { return compute(1); }').map(describe);
  assert.ok(found.includes('`compute(1)` → `null`'));
});

test('a bare return null is not mutated into itself', () => {
  const found = mutantsFor('function f() { return null; }').map(describe);
  assert.deepEqual(found, []);
});

test('onlyLines restricts mutants to the changed lines', () => {
  const code = 'const a = x < y;\nconst b = p > q;\nconst c = m === n;';
  const found = mutantsFor(code, 'sample.ts', new Set([2]));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.line, 2);
  assert.equal(describe(found[0]!), '`>` → `>=`');
});

test('applyMutant swaps exactly the operator span', () => {
  const code = 'const a = x <= y;';
  const [mutant] = mutantsFor(code);
  assert.equal(applyMutant(code, mutant!), 'const a = x < y;');
});

test('isSupported accepts source files and rejects declarations', () => {
  assert.ok(isSupported('src/a.ts'));
  assert.ok(isSupported('src/a.tsx'));
  assert.ok(isSupported('src/a.mjs'));
  assert.ok(!isSupported('src/a.d.ts'));
  assert.ok(!isSupported('README.md'));
});
