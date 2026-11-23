// engine/stall.ts — anti-pause: detect an answer that *announces* the work
// instead of doing it, and turn that into one more bounded round.
//
// Two failure shapes are covered, because free-tier models produce both:
//
// 1. THE PLAN-ONLY PAUSE. The model writes a plan, ends on "Let me write the
//    code now.", and stops with finish_reason "stop". Nothing errored, so
//    nothing retried; the build gate never fired because the workspace was
//    never touched.
//
// 2. THE ARTIFACT PROMISE. The model emits a *fragment* of the artifact and then
//    narrates its own continuation, either inside the code block or right after
//    it:
//
//      (The full, complete HTML artifact will be constructed now, including the
//       rest of the logic, animation loop, and control bindings, and written to
//       the file.)
//
//    The fence may be closed, the finish_reason may be "stop", and the answer
//    still contains no artifact. A promise is not output.
//
// The detector is deliberately narrow, because a false positive costs a round
// and appends unwanted text:
//
//   - the signal must be at the *end* of the answer (its last non-empty line,
//     its last code block, or its closing parenthetical),
//   - "announcement" means a first-person future action with a work verb, a
//     trailing colon, a permission question, a token limit reached mid-sentence,
//     a future-passive promise about the artifact, an elision marker, or a code
//     block whose braces do not balance — not merely a long answer that ends in
//     a period,
//   - and once a *finished* artifact is present, the softer rules switch off.
//
// Everything here is pure: no Deno or Node globals, no I/O, no clock. The route
// decides *whether* to spend a round; this module decides *what the answer looks
// like*, *what to say next*, and *how much output budget the request deserves*.

export type StallKind =
  | "none"
  | "intent"
  | "permission"
  | "truncated"
  | "promise"
  | "elided"
  | "plan"
  | "colon";

export interface StallOptions {
  /** Upstream finish_reason for this generation. "length" is a hard signal. */
  finish?: string;
  /** The plane owns tools for this request. */
  hasTools?: boolean;
  /** The request asked for an artifact (code, file, app, page, script). */
  wantsArtifact?: boolean;
}

export interface StallVerdict {
  stalled: boolean;
  kind: StallKind;
  /** 0..1; >= 0.6 is the router's threshold. */
  confidence: number;
  reasons: string[];
  /** Last non-empty line, truncated — what the model actually said last. */
  lastLine: string;
  /** The answer is a plan (bullets or a heading) with no artifact. */
  planOnly: boolean;
  /** A code fence was opened and never closed. */
  unterminatedFence: boolean;
  /** The artifact itself is incomplete: unbalanced braces or an elision. */
  partialArtifact: boolean;
  /** Tail of the emitted artifact, so a continuation can resume instead of
   *  restarting from the top. */
  resumeFrom: string;
}

export interface StallState {
  /** Continuations already spent on this request. */
  continuations: number;
}

export interface StallTurnOptions {
  hasTools?: boolean;
  wantsArtifact?: boolean;
  maxContinuations?: number;
  /** Force a tool call on the first continuation (default true when both
   *  `hasTools` and `wantsArtifact` are set). */
  allowToolForce?: boolean;
}

export interface StallTurn {
  round: number;
  nudge: string;
  /** Set when this continuation should force the model to act. */
  toolChoice?: "required";
}

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------

/** First-person future action: "let me …", "I'll …", "next I'll …". */
const INTENT_RE =
  /^(?:ok(?:ay)?[,.:!]?\s*|so[,.]?\s+|right[,.:]?\s+|now[,.:]?\s+|and\s+|then\s+|next[,.:]?\s+|first[,.:]?\s+)?(?:let me|let'?s|i'?ll|i will|i'?m going to|i am going to|i'?m gonna|time to|next up|back to)\b/i;

/** A verb that means "produce something", so "let me explain" is not a stall. */
const WORK_VERB_RE =
  /\b(write|writing|build|building|create|creating|make|making|implement|implementing|add|adding|set\s?up|setting\s?up|generate|generating|refactor|refactoring|fix|fixing|run|running|wire|wiring|continue|continuing|start|starting|produce|producing|draft|drafting|code|coding|assemble|assembling|scaffold|scaffolding|put\s+together|finish|finishing|update|updating|edit|editing|apply|applying)\b/i;

const PERMISSION_RE =
  /(?:shall|should|would|do)\s+(?:i|we|you)\b[^.?!]{0,80}\?|\bwant\s+me\s+to\b[^.?!]{0,80}\?|\blet\s+me\s+know\s+(?:if|when|whether)\b|\bsay\s+the\s+word\b|\bshall\s+i\s+(?:proceed|continue|go\s+ahead)\b/i;

const BULLET_RE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+\S/;

const PLAN_HEADING_RE =
  /^(?:here'?s\s+(?:my|the)\s+plan|my\s+plan|plan|steps|approach|let\s+me\s+build|let\s+me\s+start|i'?ll\s+build|what\s+i'?ll\s+do|first,?\s+let\s+me)\b/i;

/** An answer that already delivered something does not need continuing. */
const CLOSED_FENCE_RE = /```[\s\S]+?```/;

const TERMINAL_RE = /[.!?`)\]}>"'…]$/;

/** Future-passive self-narration about the artifact, and other "later" markers. */
const PROMISE_RE =
  /will\s+(?:\w+\s+){0,2}be\s+(?:constructed|written|generated|provided|completed|continued|added|included|appended|implemented)|to\s+be\s+continued|\(continuing\)|continuing\s+(?:in|on)\s+the\s+next|rest\s+of\s+the\s+(?:code|logic|file|implementation|artifact)/i;

/** "… and then I'll stop here" style placeholders inside an artifact. */
const ELISION_RE =
  /\/\/\s*(?:\.\.\.|…)|#\s*(?:\.\.\.|…)\s*$|\/\*\s*(?:\.\.\.|…)\s*\*\/|<!--\s*(?:\.\.\.|…)\s*-->|\.\.\.\s*(?:rest\s+of|remaining)|\b(?:rest|remainder)\s+of\s+the\s+(?:code|logic|file|implementation)\b/i;

/** Requests that expect an artifact rather than an explanation. */
const ARTIFACT_RE =
  /\b(build|make|create|implement|write|generate|scaffold|code|program|app|application|page|component|script|file|function|class|module|site|game|demo|tool|endpoint|api|refactor|fix)\b|```|\.(?:html|css|js|ts|tsx|jsx|py|rs|go|json|md)\b/i;

function previewLine(line: string, max = 160): string {
  const one = line.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** True when the user asked for something to be produced, not just explained. */
export function wantsArtifactRequest(text: string): boolean {
  return ARTIFACT_RE.test(text ?? "");
}

/** The last fenced code block's body, or "" when there is none. */
export function lastCodeBlock(text: string): string {
  const re = /```[\w+.#-]*\r?\n([\s\S]*?)```/g;
  let body = "";
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) body = match[1];
  return body;
}

/** Strip comments and string literals so braces inside them are not counted.
 *  Cheap and non-greedy: a truncated template literal swallows its tail, which
 *  only ever makes the check *less* eager. */
function stripNonCode(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i++;
          break;
        }
        if (quote !== "`" && code[i] === "\n") break;
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Unclosed `{` minus unclosed `}`; > 0 means the block stopped mid-scope. */
function braceDelta(code: string): number {
  let delta = 0;
  for (const ch of stripNonCode(code)) {
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
}

function tailOf(text: string, max: number): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= max ? trimmed : trimmed.slice(trimmed.length - max);
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

export function detectStall(text: string, options: StallOptions = {}): StallVerdict {
  const raw = typeof text === "string" ? text : "";
  const trimmed = raw.trim();
  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : "";
  const tail = trimmed.slice(-320);
  const reasons: string[] = [];
  let kind: StallKind = "none";
  let confidence = 0;

  const bump = (k: StallKind, c: number, reason: string): void => {
    if (c > confidence) {
      confidence = c;
      kind = k;
    }
    reasons.push(reason);
  };

  const fences = (raw.match(/```/g) ?? []).length;
  const unterminatedFence = fences % 2 === 1;
  const code = lastCodeBlock(raw);
  const delta = code.length > 0 ? braceDelta(code) : 0;
  const elided = code.length > 0 && ELISION_RE.test(code);
  // A promise to finish is itself a statement that the artifact is unfinished,
  // so it counts as incompleteness even when the fragment is syntactically
  // closed — the reported case where the code compiles but the file is a stub.
  const promised = PROMISE_RE.test(tail);
  const partialArtifact = unterminatedFence || (code.length >= 80 && delta > 0) || elided || promised;
  const closedFence = CLOSED_FENCE_RE.test(raw);
  const bulletCount = lines.filter((l) => BULLET_RE.test(l)).length;
  const wantsArtifact = options.wantsArtifact ?? false;
  const planOnly = wantsArtifact &&
    !closedFence &&
    (bulletCount >= 2 || (lines.length > 1 && PLAN_HEADING_RE.test(lines[0] ?? "")));
  const resumeFrom = code.length > 0 ? tailOf(code, 160) : tailOf(trimmed, 160);
  const verdict = (stalled: boolean, k: StallKind, c: number): StallVerdict => ({
    stalled,
    kind: k,
    confidence: Math.round(c * 100) / 100,
    reasons,
    lastLine: previewLine(lastLine),
    planOnly,
    unterminatedFence,
    partialArtifact,
    resumeFrom,
  });

  if (!trimmed) {
    if (options.finish === "length") {
      reasons.push("upstream finished at its token limit");
      return verdict(true, "truncated", 0.9);
    }
    return verdict(false, "none", 0);
  }

  // ---- hard signals, independent of what the answer says -------------------
  if (unterminatedFence) bump("truncated", 0.95, "a code fence was opened and never closed");
  if (options.finish === "length") bump("truncated", 0.9, "upstream finished at its token limit");

  // ---- the artifact itself is incomplete -----------------------------------
  // These count even when the fence is closed: a fragment followed by a
  // promise is not an artifact, and a block that stops mid-scope is truncated
  // whatever the provider reported.
  if (wantsArtifact || code.length > 0) {
    if (code.length >= 80 && delta > 0) {
      bump("truncated", 0.85, `the last code block stops mid-scope (${delta} unclosed brace(s))`);
    }
    if (elided) {
      bump("elided", 0.9, "the code block contains an elision marker instead of code");
    }
    if (promised) {
      bump("promise", 0.88, `the answer promises the rest instead of emitting it: "${previewLine(tail)}"`);
    }
  }

  // ---- the plan-only pause -------------------------------------------------
  // Everything below is about the *end* of the answer, and is suppressed once a
  // finished artifact is present: "here is the file, let me know if…" is done.
  if (!closedFence) {
    // A trailing colon, a permission question, or an announcement only count
    // when a pause is plausible: an artifact was asked for, the answer is short,
    // or it visibly stops on a colon.
    const pauseProne = wantsArtifact || trimmed.length < 600 || /[:：]\s*$/.test(trimmed);

    if (pauseProne && PERMISSION_RE.test(tail) && (wantsArtifact || trimmed.length < 400)) {
      bump("permission", 0.8, "the answer asks for permission instead of finishing");
    }

    const announces = lastLine.length > 0 &&
      INTENT_RE.test(lastLine) &&
      WORK_VERB_RE.test(lastLine);
    if (pauseProne && announces) {
      const openEnded = /[:：]\s*$/.test(lastLine) || /(?:\.\.\.|…)\s*$/.test(lastLine);
      const abrupt = !TERMINAL_RE.test(lastLine);
      bump(
        "intent",
        openEnded ? 0.92 : abrupt ? 0.85 : 0.72,
        `the answer ends by announcing more work: "${previewLine(lastLine)}"`,
      );
    }

    if (pauseProne && /[:：]\s*$/.test(trimmed) && lastLine.length <= 120) {
      bump("colon", 0.75, "the answer ends on a colon with nothing after it");
    }

    if (pauseProne && planOnly) {
      bump("plan", 0.8, "the answer is a plan (bullets or a heading) with no artifact");
    }

    // A plan that is *also* an announcement is the reported shape; make sure it
    // clears the threshold even when the last line is mild.
    if (planOnly && announces) confidence = Math.max(confidence, 0.85);
  } else if (wantsArtifact && partialArtifact) {
    // A closed fence is normally proof of delivery. Not when the artifact is a
    // fragment: say so, so the caller still knows the answer is incomplete.
    confidence = Math.max(confidence, 0.8);
    if (kind === "none") kind = "truncated";
  }

  return verdict(confidence >= 0.6, kind, confidence);
}

// ---------------------------------------------------------------------------
// the next turn
// ---------------------------------------------------------------------------

export function stallNudge(verdict: StallVerdict, options: StallTurnOptions = {}): string {
  const incomplete = verdict.partialArtifact || verdict.kind === "truncated";
  const parts: string[] = [
    incomplete
      ? `Your reply was cut off mid-way: it stops at "${previewLine(verdict.lastLine, 90)}".`
      : `You stopped before doing the work: your last line was "${previewLine(verdict.lastLine, 90)}".`,
    "Continue now in this reply. Do not restate the plan, do not narrate, do not ask for permission or confirmation.",
  ];
  if (verdict.kind === "promise" || (incomplete && verdict.kind !== "truncated")) {
    parts.push("A sentence about what you will write next is not output.");
  }
  if (options.hasTools) {
    parts.push("Use the tools you were given to make the change now.");
  }
  if (options.wantsArtifact) {
    parts.push("Emit the complete artifact — whole file, no elisions, no TODOs, no placeholders.");
  }
  if (incomplete) {
    parts.push(
      `Resume from exactly this point, with no preamble and no repetition: …${previewLine(verdict.resumeFrom, 120)}`,
    );
  }
  return parts.join(" ");
}

/** Continuations allowed per request: KONO_STALL_ROUNDS (default 2, max 6). */
export function maxStallContinuations(requested?: unknown): number {
  const env = readEnvNumber("KONO_STALL_ROUNDS") ?? readEnvNumber("NOKEY_STALL_ROUNDS");
  const base = env === undefined ? 2 : env;
  const want = typeof requested === "number" && Number.isFinite(requested) ? requested : base;
  return Math.max(0, Math.min(6, Math.round(want)));
}

/**
 * Output budget for a request that asks for an artifact. Most free relays
 * default to a few hundred output tokens, which is why a 900-line HTML demo
 * arrives as a 20-line fragment: the request never asked for more. This is the
 * default `max_tokens` the router sends when the caller sent none.
 * KONO_MAX_OUTPUT_TOKENS (default 8192, clamped to 64..65536; 0 disables the
 * floor and lets the provider default through).
 */
export function artifactOutputTokens(): number {
  const env = readEnvNumber("KONO_MAX_OUTPUT_TOKENS") ?? readEnvNumber("NOKEY_MAX_OUTPUT_TOKENS");
  const want = env === undefined ? 8192 : env;
  const clamped = Math.max(0, Math.min(65_536, Math.round(want)));
  return clamped === 0 ? 0 : Math.max(64, clamped);
}

/** Decide whether to spend a round, and what to send. `null` = stop here. */
export function nextStallTurn(
  verdict: StallVerdict,
  state: StallState,
  options: StallTurnOptions = {},
): StallTurn | null {
  const max = Math.max(0, Math.round(options.maxContinuations ?? maxStallContinuations()));
  if (!verdict.stalled || state.continuations >= max) return null;
  const round = state.continuations + 1;
  const force = (options.allowToolForce ?? true) &&
    Boolean(options.hasTools) &&
    Boolean(options.wantsArtifact) &&
    (verdict.kind === "intent" || verdict.kind === "plan" || verdict.kind === "colon") &&
    round === 1;
  return {
    round,
    nudge: stallNudge(verdict, options),
    ...(force ? { toolChoice: "required" as const } : {}),
  };
}

/** One line for a trace event or a `kono` status frame. */
export function stallSummary(verdict: StallVerdict): string {
  if (!verdict.stalled) return "none";
  return `${verdict.kind}@${verdict.confidence}: ${verdict.reasons[0] ?? ""}`.slice(0, 240);
}

function readEnvNumber(name: string): number | undefined {
  const holder = globalThis as {
    Deno?: { env?: { get(key: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  const raw = holder.Deno?.env?.get(name) ?? holder.process?.env?.[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
