// Formula language for spreadsheet cells: arithmetic, comparisons, cell
// references and ranges, and SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF,
// ROUND and ABS. Errors are plain words, never a silently wrong value.

export interface FormulaError {
  readonly kind: "formula-error";
  readonly message: string;
}

export type ComputedValue = number | string | boolean | null | FormulaError;

export function isFormulaError(value: unknown): value is FormulaError {
  return typeof value === "object" && value !== null && (value as FormulaError).kind === "formula-error";
}

export function formulaError(message: string): FormulaError {
  return { kind: "formula-error", message };
}

export const MAX_FORMULA_LENGTH = 4096;
export const MAX_RANGE_CELLS = 100_000;
const MAX_COLUMNS = 16384;
const MAX_ROWS = 1048576;
const MAX_DEPTH = 100;

export interface CellRef {
  sheet?: string;
  row: number;
  col: number;
}

export interface CellRange {
  sheet?: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** 0-based column index to letters: 0 is A, 25 is Z, 26 is AA. */
export function columnLabel(index: number): string {
  let label = "";
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/** Letters to a 0-based column index, or null when not 1-3 letters. */
export function parseColumnLabel(label: string): number | null {
  if (!/^[A-Za-z]{1,3}$/.test(label)) return null;
  let index = 0;
  for (const char of label.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  const zeroBased = index - 1;
  return zeroBased < MAX_COLUMNS ? zeroBased : null;
}

/** A1, $A$1, Sheet1!A1 and 'My Sheet'!A1; rows and columns stay inside Excel's grid. */
export function parseCellRef(text: string): CellRef | null {
  const quoted = /^'((?:[^']|'')+)'!(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(text);
  const plain = /^([A-Za-z_][A-Za-z0-9_.]*)?!(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(text);
  const bare = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(text);
  const match = quoted ?? plain ?? bare;
  if (!match) return null;
  const sheet = quoted ? quoted[1]!.replaceAll("''", "'") : plain ? plain[1] : undefined;
  const letters = (quoted ? quoted[3] : plain ? plain[3] : bare![2])!;
  const digits = (quoted ? quoted[5] : plain ? plain[5] : bare![4])!;
  const col = parseColumnLabel(letters);
  const row = Number(digits) - 1;
  if (col === null || !Number.isInteger(row) || row < 0 || row >= MAX_ROWS) return null;
  return { ...(sheet ? { sheet } : {}), row, col };
}

export function formatCellRef(ref: CellRef): string {
  const cell = `${columnLabel(ref.col)}${ref.row + 1}`;
  if (!ref.sheet) return cell;
  return /[^A-Za-z0-9_.]/.test(ref.sheet) ? `'${ref.sheet.replaceAll("'", "''")}'!${cell}` : `${ref.sheet}!${cell}`;
}

export function rangeCellCount(range: CellRange): number {
  return (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
}

/** What the evaluator reads through: the sheet model supplies evaluated cells. */
export interface FormulaResolver {
  sheetName: string;
  cell(ref: CellRef): ComputedValue;
  range(range: CellRange): ComputedValue[] | FormulaError;
}

export type AstNode =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "ref"; ref: CellRef }
  | { type: "range"; range: CellRange }
  | { type: "call"; name: string; args: AstNode[] }
  | { type: "unary"; op: "-" | "+"; expr: AstNode }
  | { type: "percent"; expr: AstNode }
  | { type: "binary"; op: string; left: AstNode; right: AstNode };

type Token =
  | { type: "number"; value: number; text: string }
  | { type: "string"; value: string; text: string }
  | { type: "quoted"; value: string; text: string }
  | { type: "ident"; value: string; text: string }
  | { type: "op"; value: string; text: string }
  | { type: "lparen"; text: string }
  | { type: "rparen"; text: string }
  | { type: "comma"; text: string }
  | { type: "bang"; text: string }
  | { type: "colon"; text: string };

const NUMERIC_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function tokenize(input: string): { tokens: Token[] } | { error: string } {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") { i++; continue; }
    if (char === '"') {
      let value = "";
      i++;
      let closed = false;
      while (i < input.length) {
        if (input[i] === '"') {
          if (input[i + 1] === '"') { value += '"'; i += 2; }
          else { closed = true; i++; break; }
        } else { value += input[i]; i++; }
      }
      if (!closed) return { error: "A piece of text is missing its closing quote." };
      tokens.push({ type: "string", value, text: `"${value}"` });
      continue;
    }
    if (char === "'") {
      let value = "";
      i++;
      let closed = false;
      while (i < input.length) {
        if (input[i] === "'") {
          if (input[i + 1] === "'") { value += "'"; i += 2; }
          else { closed = true; i++; break; }
        } else { value += input[i]; i++; }
      }
      if (!closed) return { error: "A tab name is missing its closing quote." };
      tokens.push({ type: "quoted", value, text: `'${value}'` });
      continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(i));
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) return { error: "That number is too large." };
      tokens.push({ type: "number", value, text: number[0] });
      i += number[0].length;
      continue;
    }
    const ref = /^\$?[A-Za-z]{1,3}\$?\d+/.exec(input.slice(i));
    if (ref) {
      tokens.push({ type: "ident", value: ref[0], text: ref[0] });
      i += ref[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(input.slice(i));
    if (ident) {
      tokens.push({ type: "ident", value: ident[0], text: ident[0] });
      i += ident[0].length;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      tokens.push({ type: "op", value: two, text: two });
      i += 2;
      continue;
    }
    if ("+-*/^%=<>&".includes(char)) {
      tokens.push({ type: "op", value: char, text: char });
      i++;
      continue;
    }
    if (char === "(") { tokens.push({ type: "lparen", text: char }); i++; continue; }
    if (char === ")") { tokens.push({ type: "rparen", text: char }); i++; continue; }
    if (char === "," || char === ";") { tokens.push({ type: "comma", text: char }); i++; continue; }
    if (char === "!") { tokens.push({ type: "bang", text: char }); i++; continue; }
    if (char === ":") { tokens.push({ type: "colon", text: char }); i++; continue; }
    return { error: `I could not read "${char}" in this formula.` };
  }
  return { tokens };
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  parse(): { ok: true; ast: AstNode } | { ok: false; error: string } {
    if (!this.tokens.length) return { ok: false, error: "The formula is empty." };
    const parsed = this.expression(0);
    if (!parsed.ok) return parsed;
    if (this.pos < this.tokens.length) {
      return { ok: false, error: `I could not read "${this.tokens[this.pos]!.text}" here.` };
    }
    return { ok: true, ast: parsed.ast };
  }

  private expression(depth: number): { ok: true; ast: AstNode } | { ok: false; error: string } {
    if (depth > MAX_DEPTH) return { ok: false, error: "The formula is too deeply nested." };
    return this.comparison(depth);
  }

  private comparison(depth: number): { ok: true; ast: AstNode } | { ok: false; error: string } {
    let left = this.concat(depth);
    if (!left.ok) return left;
    for (;;) {
      const token = this.peek();
      if (!token || token.type !== "op" || !["=", "<>", "<", "<=", ">", ">="].includes(token.value)) return left;
      this.next();
      const right = this.concat(depth);
      if (!right.ok) return right;
      left = { ok: true, ast: { type: "binary", op: token.value, left: left.ast, right: right.ast } };
    }
  }

  private concat(depth: number): { ok: true; ast: AstNode } | { ok: false; error: string } {
    let left = this.additive(depth);
    if (!left.ok) return left;
    while (this.peek()?.type === "op" && this.peek()!.type === "op" && (this.peek() as { value: string }).value === "&") {
      this.next();
      const right = this.additive(depth);
      if (!right.ok) return right;
      left = { ok: true, ast: { type: "binary", op: "&", left: left.ast, right: right.ast } };
    }
    return left;
  }

  private additive(depth: number): { ok: true; ast: AstNode } | { ok: false; error: string } {
    let left = this.multiplicative(depth);
    if (!left.ok) return left;
    for (;;) {
      const token = this.peek();
      if (!token || token.type !== "op" || (token.value !== "+" && token.value !== "-")) return left;
      this.next();
      const right = this.multiplicative(depth);
      if (!right.ok) return right;
      left = { ok: true, ast: { type: "binary", op: token.value, left: left.ast, right: right.ast } };
    }
  }

  private multiplicative(depth: number): { ok: true; ast: AstNode } | { ok: false; error: string } {
    let left = this.unary(depth);
    if (!left.ok) return left;
    for (;;) {
      const token = this.peek();
      if (!token || token.type !== "op" || (token.value !== "*" && token.value !== "/")) return left;
      this.next();
      const right = this.unary(depth);
      if (!right.ok) return right;
      left = { ok: true, ast: { type: "binary", op: token.value, left: left.ast, right: right.ast } };
    }
  }

  private power(depth: number): { ok: true; ast: AstNode } | { ok: false; error: string } {
    const base = this.postfix(depth);
    if (!base.ok) return base;
    const token = this.peek();
    if (!token || token.type !== "op" || token.value !== "^") return base;
    this.next();
    const exponent = this.unary(depth);
    if (!exponent.ok) return exponent;
    return { ok: true, ast: { type: "binary", op: "^", left: base.ast, right: exponent.ast } };
  }

  private unary(depth: number): { ok: true; ast: AstNode } | { ok: false; error: string } {
    const token = this.peek();
    if (token?.type === "op" && (token.value === "-" || token.value === "+")) {
      this.next();
      const expr = this.unary(depth + 1);
      if (!expr.ok) return expr;
      return { ok: true, ast: { type: "unary", op: token.value, expr: expr.ast } };
    }
    return this.power(depth);
  }

  private postfix(depth: number): { ok: true; ast: AstNode } | { ok: false; error: string } {
    let node = this.primary(depth);
    if (!node.ok) return node;
    while (this.peek()?.type === "op" && (this.peek() as { value: string }).value === "%") {
      this.next();
      node = { ok: true, ast: { type: "percent", expr: node.ast } };
    }
    return node;
  }

  private primary(depth: number): { ok: true; ast: AstNode } | { ok: false; error: string } {
    const token = this.next();
    if (!token) return { ok: false, error: "The formula ends before a value." };
    if (token.type === "number") return { ok: true, ast: { type: "number", value: token.value } };
    if (token.type === "string") return { ok: true, ast: { type: "string", value: token.value } };
    if (token.type === "lparen") {
      const inner = this.expression(depth + 1);
      if (!inner.ok) return inner;
      if (this.next()?.type !== "rparen") return { ok: false, error: "Missing closing bracket." };
      return inner;
    }
    if (token.type === "ident" || token.type === "quoted") {
      return this.identOrRef(token, depth);
    }
    return { ok: false, error: `Expected a value but found "${token.text}".` };
  }

  private identOrRef(token: Extract<Token, { type: "ident" | "quoted" }>, depth: number): { ok: true; ast: AstNode } | { ok: false; error: string } {
    if (token.type === "quoted") {
      if (this.peek()?.type !== "bang") return { ok: false, error: `A tab name needs a cell after it, like 'My Sheet'!A1.` };
      this.next();
      return this.refAfterBang(token.value);
    }
    const upper = token.value.toUpperCase();
    if (upper === "TRUE") return { ok: true, ast: { type: "boolean", value: true } };
    if (upper === "FALSE") return { ok: true, ast: { type: "boolean", value: false } };
    if (this.peek()?.type === "lparen") {
      this.next();
      const args: AstNode[] = [];
      if (this.peek()?.type !== "rparen") {
        for (;;) {
          const arg = this.expression(depth + 1);
          if (!arg.ok) return arg;
          args.push(arg.ast);
          const next = this.peek();
          if (next?.type === "comma") { this.next(); continue; }
          break;
        }
      }
      if (this.next()?.type !== "rparen") return { ok: false, error: `Missing closing bracket after ${token.value}(` };
      return { ok: true, ast: { type: "call", name: upper, args } };
    }
    if (this.peek()?.type === "bang") {
      this.next();
      return this.refAfterBang(token.value);
    }
    const ref = parseCellRef(token.value);
    if (!ref) return { ok: false, error: `I could not read "${token.value}". Use a cell like A1, or a function like SUM.` };
    return this.maybeRange(ref);
  }

  private refAfterBang(sheet: string): { ok: true; ast: AstNode } | { ok: false; error: string } {
    const token = this.next();
    if (!token || token.type !== "ident") return { ok: false, error: `A tab name needs a cell after it, like ${sheet}!A1.` };
    const ref = parseCellRef(`${sheet}!${token.value}`);
    if (!ref) return { ok: false, error: `I could not read "${sheet}!${token.value}".` };
    return this.maybeRange(ref);
  }

  private maybeRange(ref: CellRef): { ok: true; ast: AstNode } | { ok: false; error: string } {
    if (this.peek()?.type !== "colon") return { ok: true, ast: { type: "ref", ref } };
    this.next();
    const token = this.next();
    if (!token || token.type !== "ident") return { ok: false, error: "A range needs two cells, like A1:B2." };
    const end = parseCellRef(token.value);
    if (!end) return { ok: false, error: `I could not read "${token.value}" in this range.` };
    if (ref.sheet && end.sheet && ref.sheet.toLowerCase() !== end.sheet.toLowerCase()) {
      return { ok: false, error: "A range cannot cross two tabs." };
    }
    const range: CellRange = {
      ...(ref.sheet ? { sheet: ref.sheet } : {}),
      startRow: Math.min(ref.row, end.row),
      startCol: Math.min(ref.col, end.col),
      endRow: Math.max(ref.row, end.row),
      endCol: Math.max(ref.col, end.col),
    };
    if (rangeCellCount(range) > MAX_RANGE_CELLS) {
      return { ok: false, error: `That range is too large (over ${MAX_RANGE_CELLS.toLocaleString("en-US")} cells).` };
    }
    return { ok: true, ast: { type: "range", range } };
  }
}

/** A formula starts with =; anything else is a plain value, not a formula. */
export function parseFormula(text: string): { ok: true; ast: AstNode } | { ok: false; error: string } {
  if (!text.startsWith("=")) return { ok: false, error: "A formula starts with =." };
  const body = text.slice(1);
  if (body.length > MAX_FORMULA_LENGTH) return { ok: false, error: `The formula is too long (over ${MAX_FORMULA_LENGTH} characters).` };
  const tokenized = tokenize(body);
  if ("error" in tokenized) return { ok: false, error: tokenized.error };
  return new Parser(tokenized.tokens).parse();
}

export function shortNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  return String(Number(value.toPrecision(15)));
}

function toNumber(value: ComputedValue): number | FormulaError {
  if (isFormulaError(value)) return value;
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const trimmed = value.trim();
  if (NUMERIC_TEXT.test(trimmed)) return Number(trimmed);
  return formulaError(`"${value.length > 40 ? `${value.slice(0, 39)}…` : value}" is text, not a number.`);
}

function toText(value: ComputedValue): string | FormulaError {
  if (isFormulaError(value)) return value;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return shortNumber(value);
  return value;
}

function truthy(value: ComputedValue): boolean | FormulaError {
  if (isFormulaError(value)) return value;
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const upper = value.trim().toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  return formulaError("IF needs a true/false value.");
}

function compare(left: ComputedValue, right: ComputedValue): number | FormulaError {
  if (isFormulaError(left)) return left;
  if (isFormulaError(right)) return right;
  const asValue = (value: number | string | boolean | null, other: ComputedValue): number | string | boolean =>
    value === null ? (typeof other === "number" ? 0 : typeof other === "boolean" ? false : "") : value;
  const a = asValue(left, right);
  const b = asValue(right, left);
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") {
    const foldedA = a.toLowerCase();
    const foldedB = b.toLowerCase();
    return foldedA < foldedB ? -1 : foldedA > foldedB ? 1 : 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  const rank = (value: number | string | boolean): number => (typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2);
  const ordered = rank(a) - rank(b);
  return ordered < 0 ? -1 : 1;
}

type ArgValue = ComputedValue | ComputedValue[];

function collectNumbers(args: ArgValue[], name: string): number[] | FormulaError {
  const numbers: number[] = [];
  for (const arg of args) {
    const values = Array.isArray(arg) ? arg : [arg];
    for (const value of values) {
      if (isFormulaError(value)) return value;
      if (value === null) continue;
      if (typeof value === "number") { numbers.push(value); continue; }
      if (Array.isArray(arg)) continue;
      if (typeof value === "boolean") { numbers.push(value ? 1 : 0); continue; }
      const converted = toNumber(value);
      if (isFormulaError(converted)) return formulaError(`${name}: ${converted.message}`);
      numbers.push(converted);
    }
  }
  return numbers;
}

function countNumbers(args: ArgValue[]): number | FormulaError {
  let count = 0;
  for (const arg of args) {
    const values = Array.isArray(arg) ? arg : [arg];
    for (const value of values) {
      if (isFormulaError(value)) return value;
      if (typeof value !== "number") continue;
      count++;
    }
  }
  return count;
}

function countNonEmpty(args: ArgValue[]): number | FormulaError {
  let count = 0;
  for (const arg of args) {
    const values = Array.isArray(arg) ? arg : [arg];
    for (const value of values) {
      if (isFormulaError(value)) return value;
      if (value !== null) count++;
    }
  }
  return count;
}

const FUNCTION_NAMES = ["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "IF", "ROUND", "ABS"];

function callFunction(name: string, args: ArgValue[]): ComputedValue {
  const arity = (min: number, max: number): FormulaError | null =>
    args.length < min || args.length > max
      ? formulaError(`${name} needs ${min === max ? min : `${min} to ${max}`} value${min === max && min === 1 ? "" : "s"}.`)
      : null;
  switch (name) {
    case "SUM": {
      const bad = arity(1, 255);
      if (bad) return bad;
      const numbers = collectNumbers(args, name);
      if (isFormulaError(numbers)) return numbers;
      const total = numbers.reduce((sum, n) => sum + n, 0);
      return Number.isFinite(total) ? total : formulaError("The result is too large.");
    }
    case "AVERAGE": {
      const bad = arity(1, 255);
      if (bad) return bad;
      const numbers = collectNumbers(args, name);
      if (isFormulaError(numbers)) return numbers;
      if (!numbers.length) return formulaError("AVERAGE has no numbers to average.");
      return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
    }
    case "MIN": {
      const bad = arity(1, 255);
      if (bad) return bad;
      const numbers = collectNumbers(args, name);
      if (isFormulaError(numbers)) return numbers;
      return numbers.length ? Math.min(...numbers) : 0;
    }
    case "MAX": {
      const bad = arity(1, 255);
      if (bad) return bad;
      const numbers = collectNumbers(args, name);
      if (isFormulaError(numbers)) return numbers;
      return numbers.length ? Math.max(...numbers) : 0;
    }
    case "COUNT": {
      const bad = arity(1, 255);
      if (bad) return bad;
      return countNumbers(args);
    }
    case "COUNTA": {
      const bad = arity(1, 255);
      if (bad) return bad;
      return countNonEmpty(args);
    }
    case "IF": {
      const bad = arity(2, 3);
      if (bad) return bad;
      const condition = args[0]!;
      if (Array.isArray(condition)) return formulaError("IF needs one value, not a range.");
      const ok = truthy(condition);
      if (isFormulaError(ok)) return ok;
      const chosen = ok ? args[1]! : (args[2] ?? false);
      if (Array.isArray(chosen)) return formulaError("IF needs one value, not a range.");
      return chosen;
    }
    case "ROUND": {
      const bad = arity(1, 2);
      if (bad) return bad;
      const value = args[0]!;
      if (Array.isArray(value)) return formulaError("ROUND needs one value, not a range.");
      const number = toNumber(value);
      if (isFormulaError(number)) return number;
      let digits = 0;
      if (args[1] !== undefined) {
        const raw = args[1];
        if (Array.isArray(raw)) return formulaError("ROUND needs one value, not a range.");
        const parsed = toNumber(raw);
        if (isFormulaError(parsed)) return parsed;
        if (!Number.isInteger(parsed) || Math.abs(parsed) > 30) {
          return formulaError("ROUND needs whole decimal places between -30 and 30.");
        }
        digits = parsed;
      }
      const factor = 10 ** digits;
      const rounded = Math.sign(number) * Math.round(Math.abs(number) * factor) / factor;
      return Number.isFinite(rounded) ? rounded : formulaError("The result is too large.");
    }
    case "ABS": {
      const bad = arity(1, 1);
      if (bad) return bad;
      const value = args[0]!;
      if (Array.isArray(value)) return formulaError("ABS needs one value, not a range.");
      const number = toNumber(value);
      if (isFormulaError(number)) return number;
      return Math.abs(number);
    }
    default:
      return formulaError(`There is no function called ${name}. Try ${FUNCTION_NAMES.join(", ")}.`);
  }
}

function evaluate(node: AstNode, resolver: FormulaResolver): ComputedValue {
  switch (node.type) {
    case "number":
    case "string":
    case "boolean":
      return node.value;
    case "ref":
      return resolver.cell(node.ref);
    case "range":
      return formulaError("A range like A1:B2 needs a function such as SUM around it.");
    case "call": {
      const args: ArgValue[] = [];
      for (const arg of node.args) {
        if (arg.type === "range") {
          const values = resolver.range(arg.range);
          if (isFormulaError(values)) return values;
          args.push(values);
        } else {
          const value = evaluate(arg, resolver);
          if (isFormulaError(value)) return value;
          args.push(value);
        }
      }
      return callFunction(node.name, args);
    }
    case "unary": {
      const value = evaluate(node.expr, resolver);
      const number = toNumber(value);
      if (isFormulaError(number)) return number;
      return node.op === "-" ? -number : number;
    }
    case "percent": {
      const value = evaluate(node.expr, resolver);
      const number = toNumber(value);
      if (isFormulaError(number)) return number;
      return number / 100;
    }
    case "binary": {
      const left = evaluate(node.left, resolver);
      if (isFormulaError(left)) return left;
      const right = evaluate(node.right, resolver);
      if (isFormulaError(right)) return right;
      switch (node.op) {
        case "+":
        case "-":
        case "*":
        case "/":
        case "^": {
          const a = toNumber(left);
          if (isFormulaError(a)) return a;
          const b = toNumber(right);
          if (isFormulaError(b)) return b;
          if (node.op === "/" && b === 0) return formulaError("Cannot divide by zero.");
          const result = node.op === "+" ? a + b : node.op === "-" ? a - b : node.op === "*" ? a * b : node.op === "/" ? a / b : a ** b;
          return Number.isFinite(result) ? result : formulaError("The result is too large.");
        }
        case "&": {
          const a = toText(left);
          if (isFormulaError(a)) return a;
          const b = toText(right);
          if (isFormulaError(b)) return b;
          return a + b;
        }
        case "=":
        case "<>":
        case "<":
        case "<=":
        case ">":
        case ">=": {
          const compared = compare(left, right);
          if (isFormulaError(compared)) return compared;
          return node.op === "=" ? compared === 0 : node.op === "<>" ? compared !== 0 : node.op === "<" ? compared < 0 : node.op === "<=" ? compared <= 0 : node.op === ">" ? compared > 0 : compared >= 0;
        }
        default:
          return formulaError(`I could not read "${node.op}" in this formula.`);
      }
    }
  }
}

/** Parse and evaluate a formula against a resolver; a bad formula is an error value, never a wrong number. */
export function evaluateFormulaText(text: string, resolver: FormulaResolver): ComputedValue {
  const parsed = parseFormula(text);
  if (!parsed.ok) return formulaError(parsed.error);
  return evaluate(parsed.ast, resolver);
}
