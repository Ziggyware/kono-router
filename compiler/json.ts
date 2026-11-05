// Reasoning models leak deliberation into `content`, often quoting JSON
// fragments on the way. The reply is the LAST balanced JSON block that has
// the expected shape, parsed through the plane's repair ladder.
import { parseToolArguments } from "../tools.ts";

const MAX_STARTS = 256;

function closeAt(s: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

export function stripThinking(text: string): string {
  return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();
}

/** Last JSON value in `text` (outermost first among blocks ending at the same place) that `accept` admits. */
export function lastJson(text: string, accept: (v: unknown) => boolean): unknown {
  const s = stripThinking(text);
  const starts: number[] = [];
  for (let i = s.length - 1; i >= 0 && starts.length < MAX_STARTS; i--) if (s[i] === "{" || s[i] === "[") starts.push(i);
  let best: { end: number; start: number; value: unknown } | undefined;
  for (const start of starts) {
    const end = closeAt(s, start);
    if (end < 0 || (best && end < best.end)) continue;
    const block = s.slice(start, end + 1);
    let value: unknown;
    try {
      value = JSON.parse(block);
    } catch {
      const r = parseToolArguments(block);
      if (!r.ok || r.strategy === "salvage") continue;
      value = r.value;
    }
    if (accept(value) && (!best || end > best.end || start < best.start)) best = { end, start, value };
  }
  if (best) return best.value;
  // No balanced block: the reply may be truncated mid-object, which the repair ladder can close.
  const whole = parseToolArguments(s);
  return whole.ok && whole.strategy !== "salvage" && accept(whole.value) ? whole.value : undefined;
}
