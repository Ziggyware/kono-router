// engine/stall.ts — anti-pause: detect an answer that *announces* the work
// instead of doing it, and turn that into one more bounded round.
//
// The failure this fixes, which shows up constantly on free-tier models:
//
//   "Let me build:
//      - HTML5 Canvas
//      - Fresnel lens phase mask
//      - Angular spectrum method ...
//    I'll write it as a single self-contained HTML file with comments ...
//    Let me write the code now."
//
// ...and then the stream ends with finish_reason "stop". The client got a plan,
// no artifact, and the session looks paused. Nothing errored, so nothing
// retried, nothing escalated, and the build gate never fired because the
// workspace was never touched.
//
// The detector is deliberately narrow, because a false positive costs a round
// and appends unwanted text:
//
//   - the signal must be at the *end* of the answer (its last non-empty line),
//   - the answer must not already carry a finished artifact (a closed code
//     fence or a substantial body), and
//   - "announcement" means a first-person future action with a work verb, a
//     trailing colon, a permission question, an unterminated fence, or a token
//     limit reached mid-sentence — not merely a long answer that ends in a period.
//
// Everything here is pure: no Deno or Node globals, no I/O, no clock. The route
// decides *whether* to spend a round; this module decides *what the answer looks
// like* and *what to say next*.

export type StallKind =
  | "none"
  | "intent"
  | "permission"
  | "truncated"
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
  const closedFence = CLOSED_FENCE_RE.test(raw);
  const bulletCount = lines.filter((l) => BULLET_RE.test(l)).length;
  const wantsArtifact = options.wantsArtifact ?? false;
  const planOnly = wantsArtifact &&
    !closedFence &&
    (bulletCount >= 2 || (lines.length > 1 && PLAN_HEADING_RE.test(lines[0] ?? "")));

  if (!trimmed) {
    return {
      stalled: false,
      kind: options.finish === "length" ? "truncated" : "none",
      confidence: options.finish === "length" ? 0.9 : 0,
      reasons: options.finish === "length" ? ["upstream finished at its token limit"] : [],
      lastLine: "",
      planOnly: false,
      unterminatedFence: false,
    };
  }

  // Hard signals, independent of what the answer says.
  if (unterminatedFence) bump("truncated", 0.95, "a code fence was opened and never closed");
  if (options.finish === "length") bump("truncated", 0.9, "upstream finished at its token limit");

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

    // A plan that is *also* an announcement is the exact reported shape; make
    // sure it clears the threshold even when the last line is mild.
    if (planOnly && announces) confidence = Math.max(confidence, 0.85);
  }

  return {
    stalled: confidence >= 0.6,
    kind,
    confidence: Math.round(confidence * 100) / 100,
    reasons,
    lastLine: previewLine(lastLine),
    planOnly,
    unterminatedFence,
  };
}

// ---------------------------------------------------------------------------
// the next turn
// ---------------------------------------------------------------------------

export function stallNudge(verdict: StallVerdict, options: StallTurnOptions = {}): string {
  const parts: string[] = [
    `You stopped before doing the work: your last line was "${previewLine(verdict.lastLine, 120)}".`,
    "Continue now, in this reply. Do not restate the plan, do not describe what you are about to do, do not ask for permission or confirmation.",
  ];
  if (options.hasTools) {
    parts.push("Use the tools you were given to make the change now; the router executes them and returns the result.");
  }
  if (options.wantsArtifact) {
    parts.push("Emit the complete artifact — the whole file, no elisions, no TODOs, no placeholders.");
  }
  if (verdict.kind === "truncated") {
    parts.push("Your previous reply was cut off mid-way; resume exactly where it stopped and finish it.");
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
