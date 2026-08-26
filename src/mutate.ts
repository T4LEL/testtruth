import ts from 'typescript';

/**
 * Mutants are produced from the TypeScript parser's AST rather than from a
 * regex over the source.
 *
 * This matters more than it sounds. A textual mutator cannot tell `a < b` from
 * `Array<string>`, and a mutant that fails to parse makes the whole suite error
 * out — which scores as "killed". Enough of those and every test suite looks
 * strong, which is the exact opposite of what this tool is for.
 */

export interface Mutant {
  file: string;
  /** 1-based, matching what an editor and a diff both show. */
  line: number;
  column: number;
  /** Byte offsets into the original text. */
  start: number;
  end: number;
  original: string;
  replacement: string;
  /** Short human label, e.g. "boundary comparison". */
  kind: string;
}

const BINARY_SWAPS: Partial<Record<ts.SyntaxKind, [string, string]>> = {
  [ts.SyntaxKind.LessThanToken]: ['<', '<='],
  [ts.SyntaxKind.LessThanEqualsToken]: ['<=', '<'],
  [ts.SyntaxKind.GreaterThanToken]: ['>', '>='],
  [ts.SyntaxKind.GreaterThanEqualsToken]: ['>=', '>'],
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: ['===', '!=='],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ['!==', '==='],
  [ts.SyntaxKind.EqualsEqualsToken]: ['==', '!='],
  [ts.SyntaxKind.ExclamationEqualsToken]: ['!=', '=='],
  [ts.SyntaxKind.AmpersandAmpersandToken]: ['&&', '||'],
  [ts.SyntaxKind.BarBarToken]: ['||', '&&'],
  [ts.SyntaxKind.QuestionQuestionToken]: ['??', '||'],
  [ts.SyntaxKind.PlusToken]: ['+', '-'],
  [ts.SyntaxKind.MinusToken]: ['-', '+'],
  [ts.SyntaxKind.AsteriskToken]: ['*', '/'],
  [ts.SyntaxKind.SlashToken]: ['/', '*'],
  [ts.SyntaxKind.PercentToken]: ['%', '*'],
};

const KIND_LABEL: Record<string, string> = {
  '<': 'boundary comparison',
  '<=': 'boundary comparison',
  '>': 'boundary comparison',
  '>=': 'boundary comparison',
  '===': 'equality check',
  '!==': 'equality check',
  '==': 'equality check',
  '!=': 'equality check',
  '&&': 'logical operator',
  '||': 'logical operator',
  '??': 'nullish fallback',
  '+': 'arithmetic',
  '-': 'arithmetic',
  '*': 'arithmetic',
  '/': 'arithmetic',
  '%': 'arithmetic',
};

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function isSupported(file: string): boolean {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file) && !file.endsWith('.d.ts');
}

/**
 * Generate mutants for `file`. When `onlyLines` is given, only expressions
 * starting on those 1-based lines are mutated — that is what keeps a run over a
 * pull request to seconds instead of hours.
 */
export function generateMutants(
  file: string,
  text: string,
  onlyLines?: ReadonlySet<number>,
): Mutant[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind(file),
  );

  const mutants: Mutant[] = [];

  const at = (pos: number) => {
    const { line, character } = source.getLineAndCharacterOfPosition(pos);
    return { line: line + 1, column: character + 1 };
  };

  const push = (start: number, end: number, original: string, replacement: string, kind: string) => {
    const { line, column } = at(start);
    if (onlyLines && !onlyLines.has(line)) return;
    mutants.push({ file, line, column, start, end, original, replacement, kind });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const swap = BINARY_SWAPS[node.operatorToken.kind];
      // Type-level positions never reach here, but a `+` on strings still does,
      // and swapping it to `-` is a genuine behaviour change worth testing.
      if (swap) {
        push(
          node.operatorToken.getStart(source),
          node.operatorToken.getEnd(),
          swap[0],
          swap[1],
          KIND_LABEL[swap[0]] ?? 'operator',
        );
      }
    } else if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken
    ) {
      const start = node.getStart(source);
      push(start, start + 1, '!', '', 'negation removed');
    } else if (node.kind === ts.SyntaxKind.TrueKeyword) {
      push(node.getStart(source), node.getEnd(), 'true', 'false', 'boolean literal');
    } else if (node.kind === ts.SyntaxKind.FalseKeyword) {
      push(node.getStart(source), node.getEnd(), 'false', 'true', 'boolean literal');
    } else if (ts.isNumericLiteral(node) && !isEnumOrTypePosition(node)) {
      const raw = node.getText(source);
      const replacement = numericTwin(raw);
      if (replacement !== null) {
        push(node.getStart(source), node.getEnd(), raw, replacement, 'numeric constant');
      }
    } else if (ts.isReturnStatement(node) && node.expression) {
      // Deleting the value is the classic "does anything check what I return?"
      // probe, and tests that only assert "it did not throw" survive it.
      const expr = node.expression;
      const raw = expr.getText(source);
      if (raw !== 'null' && raw !== 'undefined' && raw.length <= 40) {
        push(expr.getStart(source), expr.getEnd(), raw, 'null', 'return value');
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return mutants;
}

/** `0 <-> 1`, otherwise off-by-one, which is the bug tests most often miss. */
function numericTwin(raw: string): string | null {
  if (/[.eExXbBoO_]/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  if (value === 0) return '1';
  if (value === 1) return '0';
  return String(value + 1);
}

/** Enum members and type-level literals are not runtime behaviour. */
function isEnumOrTypePosition(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isEnumMember(p) || ts.isTypeNode(p) || ts.isTypeAliasDeclaration(p)) return true;
    if (ts.isStatement(p) || ts.isFunctionLike(p)) return false;
  }
  return false;
}

export function applyMutant(text: string, mutant: Mutant): string {
  return text.slice(0, mutant.start) + mutant.replacement + text.slice(mutant.end);
}

export function describe(mutant: Mutant): string {
  const to = mutant.replacement === '' ? 'removed' : `\`${mutant.replacement}\``;
  return `\`${mutant.original}\` → ${to}`;
}
