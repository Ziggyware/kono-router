// Deterministic arithmetic. No eval, no Function constructor, no dependency on
// the host: a Pratt parser over a frozen grammar, an AST cache, and a small
// statistical core. Safe to run on untrusted model output.

import { clamp, erf, normalCdf, normalQuantile } from "../math.ts";

type Node =
  | { k: "num"; v: number }
  | { k: "var"; v: string }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] };

type Tok = { t: "num" | "id" | "op" | "(" | ")" | ","; v: string; n?: number };

const BIN_PREC: Record<string, number> = {
  "||": 1, "&&": 2,
  "==": 3, "!=": 3, "<": 3, "<=": 3, ">": 3, ">=": 3,
  "+": 4, "-": 4,
  "*": 5, "/": 5, "%": 5, "//": 5,
  "^": 6, "**": 6,
};
const RIGHT = new Set(["^", "**"]);

const CONSTANTS: Record<string, number> = {
  pi: Math.PI, tau: Math.PI * 2, e: Math.E, phi: (1 + Math.sqrt(5)) / 2,
  sqrt2: Math.SQRT2, ln2: Math.LN2, ln10: Math.LN10, inf: Infinity, infinity: Infinity,
};

const gcd = (a: number, b: number): number => {
  a = Math.abs(Math.trunc(a)); b = Math.abs(Math.trunc(b));
  while (b) [a, b] = [b, a % b];
  return a;
};

function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) return NaN;
  if (n > 170) return Infinity;
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

type Fn = { min: number; max: number; f: (...xs: number[]) => number };

function functions(angle: "rad" | "deg"): Record<string, Fn> {
  const toRad = (x: number) => (angle === "deg" ? (x * Math.PI) / 180 : x);
  const fromRad = (x: number) => (angle === "deg" ? (x * 180) / Math.PI : x);
  return {
    abs: { min: 1, max: 1, f: Math.abs },
    sign: { min: 1, max: 1, f: Math.sign },
    sqrt: { min: 1, max: 1, f: Math.sqrt },
    cbrt: { min: 1, max: 1, f: Math.cbrt },
    exp: { min: 1, max: 1, f: Math.exp },
    ln: { min: 1, max: 1, f: Math.log },
    log: { min: 1, max: 2, f: (x, base = 10) => Math.log(x) / Math.log(base) },
    log2: { min: 1, max: 1, f: Math.log2 },
    log10: { min: 1, max: 1, f: Math.log10 },
    sin: { min: 1, max: 1, f: (x) => Math.sin(toRad(x)) },
    cos: { min: 1, max: 1, f: (x) => Math.cos(toRad(x)) },
    tan: { min: 1, max: 1, f: (x) => Math.tan(toRad(x)) },
    asin: { min: 1, max: 1, f: (x) => fromRad(Math.asin(x)) },
    acos: { min: 1, max: 1, f: (x) => fromRad(Math.acos(x)) },
    atan: { min: 1, max: 1, f: (x) => fromRad(Math.atan(x)) },
    atan2: { min: 2, max: 2, f: (y, x) => fromRad(Math.atan2(y, x)) },
    sinh: { min: 1, max: 1, f: Math.sinh },
    cosh: { min: 1, max: 1, f: Math.cosh },
    tanh: { min: 1, max: 1, f: Math.tanh },
    floor: { min: 1, max: 1, f: Math.floor },
    ceil: { min: 1, max: 1, f: Math.ceil },
    trunc: { min: 1, max: 1, f: Math.trunc },
    round: { min: 1, max: 2, f: (x, dp = 0) => { const s = 10 ** dp; return Math.round(x * s) / s; } },
    pow: { min: 2, max: 2, f: Math.pow },
    hypot: { min: 1, max: 8, f: (...xs) => Math.hypot(...xs) },
    min: { min: 1, max: 64, f: (...xs) => Math.min(...xs) },
    max: { min: 1, max: 64, f: (...xs) => Math.max(...xs) },
    clamp: { min: 3, max: 3, f: (x, lo, hi) => clamp(x, lo, hi) },
    lerp: { min: 3, max: 3, f: (a, b, t) => a + (b - a) * t },
    mod: { min: 2, max: 2, f: (a, b) => ((a % b) + b) % b },
    gcd: { min: 2, max: 2, f: gcd },
    lcm: { min: 2, max: 2, f: (a, b) => (gcd(a, b) === 0 ? 0 : Math.abs(a * b) / gcd(a, b)) },
    fact: { min: 1, max: 1, f: factorial },
    factorial: { min: 1, max: 1, f: factorial },
    erf: { min: 1, max: 1, f: erf },
    erfc: { min: 1, max: 1, f: (x) => 1 - erf(x) },
    norm_cdf: { min: 1, max: 1, f: normalCdf },
    norm_pdf: { min: 1, max: 2, f: (x, sd = 1) => Math.exp(-(x * x) / (2 * sd * sd)) / (sd * Math.sqrt(2 * Math.PI)) },
    norm_quantile: { min: 1, max: 1, f: normalQuantile },
  };
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9_]/.test(src[j])) j++;
      if (src[j] === ".") { j++; while (j < src.length && /[0-9_]/.test(src[j])) j++; }
      if (src[j] === "e" || src[j] === "E") {
        let k = j + 1;
        if (src[k] === "+" || src[k] === "-") k++;
        if (/[0-9]/.test(src[k] ?? "")) { j = k; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      }
      const raw = src.slice(i, j).replace(/_/g, "");
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`bad number "${raw}"`);
      out.push({ t: "num", v: raw, n });
      i = j;
      continue;
    }
    if (/[A-Za-z_\u0370-\u03ff]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_\u0370-\u03ff]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") { out.push({ t: ch, v: ch }); i++; continue; }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (["//", "**", "==", "!=", "<=", ">=", "&&", "||"].includes(two)) { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/%^<>!".includes(ch)) { out.push({ t: "op", v: ch }); i++; continue; }
    if (three === "mod") { out.push({ t: "op", v: "%" }); i += 3; continue; }
    throw new Error(`unexpected character "${ch}" at ${i}`);
  }
  return out;
}

class Parser {
  #t: Tok[];
  #i = 0;
  constructor(tokens: Tok[]) { this.#t = tokens; }
  #peek(): Tok | undefined { return this.#t[this.#i]; }
  #eat(v?: string): Tok {
    const tok = this.#t[this.#i];
    if (!tok) throw new Error("unexpected end of expression");
    if (v !== undefined && tok.v !== v) throw new Error(`expected "${v}", found "${tok.v}"`);
    this.#i++;
    return tok;
  }
  parse(): Node {
    const n = this.#expr(0);
    if (this.#i < this.#t.length) throw new Error(`unexpected "${this.#t[this.#i].v}"`);
    return n;
  }
  #expr(minPrec: number): Node {
    let left = this.#unary();
    for (;;) {
      const tok = this.#peek();
      if (!tok || tok.t !== "op") break;
      const prec = BIN_PREC[tok.v];
      if (prec === undefined || prec < minPrec) break;
      this.#i++;
      const right = this.#expr(RIGHT.has(tok.v) ? prec : prec + 1);
      left = { k: "bin", op: tok.v, a: left, b: right };
    }
    return left;
  }
  #unary(): Node {
    const tok = this.#peek();
    if (tok?.t === "op" && (tok.v === "-" || tok.v === "+" || tok.v === "!")) {
      this.#i++;
      // `-3^2` is `-(3^2)`: unary minus binds looser than exponentiation, so its
      // operand is parsed at the power precedence instead of recursively.
      const operand = tok.v === "!" ? this.#unary() : this.#expr(6);
      return { k: "un", op: tok.v, a: operand };
    }
    return this.#primary();
  }
  #primary(): Node {
    const tok = this.#eat();
    if (tok.t === "num") return { k: "num", v: tok.n! };
    if (tok.t === "(") {
      const inner = this.#expr(0);
      this.#eat(")");
      return inner;
    }
    if (tok.t === "id") {
      if (this.#peek()?.t === "(") {
        this.#i++;
        const args: Node[] = [];
        if (this.#peek()?.t !== ")") {
          for (;;) {
            args.push(this.#expr(0));
            if (this.#peek()?.t === ",") { this.#i++; continue; }
            break;
          }
        }
        this.#eat(")");
        if (args.length > 64) throw new Error("too many arguments");
        return { k: "call", name: tok.v, args };
      }
      return { k: "var", v: tok.v };
    }
    throw new Error(`unexpected "${tok.v}"`);
  }
}

const AST_CACHE = new Map<string, Node>();

export interface EvalOptions {
  angle?: "rad" | "deg";
  variables?: Record<string, number>;
}

export function evaluate(expression: string, opts: EvalOptions = {}): number {
  const src = expression.trim();
  if (!src) throw new Error("empty expression");
  if (src.length > 4000) throw new Error("expression too long");
  let ast = AST_CACHE.get(src);
  if (!ast) {
    ast = new Parser(lex(src)).parse();
    if (AST_CACHE.size > 512) AST_CACHE.clear();
    AST_CACHE.set(src, ast);
  }
  const fns = functions(opts.angle ?? "rad");
  const vars = opts.variables ?? {};
  let budget = 100_000;
  const run = (node: Node): number => {
    if (--budget < 0) throw new Error("expression too complex");
    switch (node.k) {
      case "num": return node.v;
      case "var": {
        if (node.v in vars) return vars[node.v];
        if (node.v in CONSTANTS) return CONSTANTS[node.v];
        throw new Error(`unknown variable "${node.v}"`);
      }
      case "un": {
        const a = run(node.a);
        return node.op === "-" ? -a : node.op === "+" ? a : a === 0 ? 1 : 0;
      }
      case "bin": {
        if (node.op === "&&") return run(node.a) !== 0 && run(node.b) !== 0 ? 1 : 0;
        if (node.op === "||") return run(node.a) !== 0 || run(node.b) !== 0 ? 1 : 0;
        const a = run(node.a), b = run(node.b);
        switch (node.op) {
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return a / b;
          case "//": return Math.floor(a / b);
          case "%": return a % b;
          case "^": case "**": return a ** b;
          case "==": return a === b ? 1 : 0;
          case "!=": return a !== b ? 1 : 0;
          case "<": return a < b ? 1 : 0;
          case "<=": return a <= b ? 1 : 0;
          case ">": return a > b ? 1 : 0;
          case ">=": return a >= b ? 1 : 0;
          default: throw new Error(`unsupported operator "${node.op}"`);
        }
      }
      case "call": {
        const fn = fns[node.name];
        if (!fn) throw new Error(`unknown function "${node.name}"`);
        if (node.args.length < fn.min || node.args.length > fn.max) {
          throw new Error(`${node.name} expects ${fn.min === fn.max ? fn.min : `${fn.min}-${fn.max}`} arguments, got ${node.args.length}`);
        }
        return fn.f(...node.args.map(run));
      }
    }
  };
  return run(ast);
}

/** Kill float dust (`0.30000000000000004`) without lying about precision. */
export function formatNumber(value: number, precision = 12): number {
  if (!Number.isFinite(value)) return value;
  if (Object.is(value, -0)) return 0;
  const rounded = Number(value.toPrecision(precision));
  return Object.is(rounded, -0) ? 0 : rounded;
}

// --- statistics -------------------------------------------------------------

export interface StatsOptions {
  quantiles?: number[];
  bins?: number;
}

export function statistics(values: number[], opts: StatsOptions = {}) {
  const xs = values.filter((v) => Number.isFinite(v));
  const n = xs.length;
  if (n === 0) throw new Error("no finite values");
  const sorted = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => {
    const pos = clamp(p, 0, 1) * (n - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  // Welford: one pass, numerically stable, no catastrophic cancellation.
  let mean = 0, m2 = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - mean;
    mean += d / (i + 1);
    m2 += d * (xs[i] - mean);
  }
  const variance = n > 1 ? m2 / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  // Skewness / kurtosis from central moments (population form).
  let s2 = 0, s3 = 0, s4 = 0;
  for (const x of xs) {
    const d = x - mean;
    s2 += d * d; s3 += d * d * d; s4 += d * d * d * d;
  }
  const varP = s2 / n;
  const skew = varP > 0 ? (s3 / n) / Math.pow(varP, 1.5) : 0;
  const kurt = varP > 0 ? (s4 / n) / (varP * varP) - 3 : 0;

  const iqr = q(0.75) - q(0.25);
  const loFence = q(0.25) - 1.5 * iqr;
  const hiFence = q(0.75) + 1.5 * iqr;
  const outliers = xs.filter((x) => x < loFence || x > hiFence);

  const width = (2 * iqr) / Math.cbrt(n) || (sorted[n - 1] - sorted[0]) / (opts.bins ?? 10) || 1;
  const binCount = clamp(Math.ceil((sorted[n - 1] - sorted[0]) / width) || 1, 1, 40);
  const start = sorted[0];
  const histogram = Array.from({ length: binCount }, (_, i) => ({
    from: formatNumber(start + i * width),
    to: formatNumber(start + (i + 1) * width),
    count: 0,
  }));
  for (const x of xs) {
    const idx = clamp(Math.floor((x - start) / width), 0, binCount - 1);
    histogram[idx].count++;
  }

  return {
    count: n,
    sum: formatNumber(xs.reduce((a, b) => a + b, 0)),
    mean: formatNumber(mean),
    median: formatNumber(q(0.5)),
    sd: formatNumber(sd),
    variance: formatNumber(variance),
    min: formatNumber(sorted[0]),
    max: formatNumber(sorted[n - 1]),
    range: formatNumber(sorted[n - 1] - sorted[0]),
    skewness: formatNumber(skew),
    kurtosis: formatNumber(kurt),
    quartiles: {
      q1: formatNumber(q(0.25)),
      q3: formatNumber(q(0.75)),
      iqr: formatNumber(iqr),
    },
    quantiles: Object.fromEntries((opts.quantiles ?? [0.5, 0.9, 0.95, 0.99]).map((p) => [`p${p * 100}`.replace(".", "_"), formatNumber(q(p))])),
    outliers: { rule: "tukey-1.5-iqr", fences: [formatNumber(loFence), formatNumber(hiFence)], count: outliers.length, values: outliers.slice(0, 20).map((v) => formatNumber(v)) },
    histogram,
  };
}
