// tools-text.ts — text tool-call parsing extracted from tools.ts.




export type Json = Record<string, unknown>;



export function isPlainObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}



/**
 * Single-pass, string-aware JSON normaliser. Fixes the five failure families
 * small models actually produce: comments, single quotes, bare keys, non-JSON
 * literals (None/True/NaN/undefined) and truncation by `max_tokens`.
 */
export function repairJsonText(source: string): { text: string; repairs: string[] } {
  const repairs: string[] = [];
  const out: string[] = [];
  const stack: string[] = [];
  let inString = false;
  let quote = '"';
  let i = 0;
  const n = source.length;

  const literals: Record<string, string> = {
    true: "true",
    false: "false",
    null: "null",
    none: "null",
    nil: "null",
    undefined: "null",
    nan: "null",
    infinity: "1e999",
    "-infinity": "-1e999",
  };

  const skipWs = (from: number): number => {
    let j = from;
    while (j < n && /\s/.test(source[j])) j++;
    return j;
  };

  while (i < n) {
    const ch = source[i];

    if (inString) {
      if (ch === "\\") {
        const nxt = source[i + 1];
        if (nxt === "\n") {
          repairs.push("line-continuation");
          i += 2;
          continue;
        }
        if (nxt === undefined) {
          out.push("\\\\");
          i++;
          continue;
        }
        out.push(ch, nxt);
        i += 2;
        continue;
      }
      if (ch === quote) {
        out.push('"');
        inString = false;
        i++;
        continue;
      }
      if (quote === "'" && ch === '"') {
        out.push('\\"');
        i++;
        continue;
      }
      if (ch === "\n") {
        repairs.push("raw-newline");
        out.push("\\n");
        i++;
        continue;
      }
      if (ch === "\r") {
        out.push("\\r");
        i++;
        continue;
      }
      if (ch === "\t") {
        out.push("\\t");
        i++;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        repairs.push("control-char");
        out.push(`\\u${code.toString(16).padStart(4, "0")}`);
        i++;
        continue;
      }
      out.push(ch);
      i++;
      continue;
    }

    // --- outside a string ---------------------------------------------------
    if (ch === "/" && source[i + 1] === "/") {
      repairs.push("comment");
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      repairs.push("comment");
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (ch === "'") repairs.push("single-quote");
      inString = true;
      quote = ch;
      out.push('"');
      i++;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      out.push(ch);
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const expected = stack.pop();
      if (expected && expected !== ch) repairs.push("mismatched-bracket");
      // `{"a":1,}` is the most common near-miss; drop the dangling separator.
      for (let k = out.length - 1; k >= 0; k--) {
        if (/^\s+$/.test(out[k])) continue;
        if (out[k] === ",") {
          out.splice(k, 1);
          repairs.push("trailing-comma");
        }
        break;
      }
      out.push(ch);
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      const word = source.slice(i, j);
      const after = skipWs(j);
      if (source[after] === ":") {
        repairs.push("bare-key");
        out.push(`"${word}"`);
        i = j;
        continue;
      }
      const mapped = literals[word.toLowerCase()];
      if (mapped) {
        if (!["true", "false", "null"].includes(word)) repairs.push("literal");
        out.push(mapped);
        i = j;
        continue;
      }
      // A bare word that is neither key nor literal: quote it as a string so
      // the payload still parses and validation can complain precisely.
      repairs.push("bare-word");
      out.push(`"${word}"`);
      i = j;
      continue;
    }
    if (/\s/.test(ch)) {
      out.push(ch);
      i++;
      continue;
    }
    out.push(ch);
    i++;
  }

  if (inString) {
    repairs.push("unterminated-string");
    out.push('"');
  }

  if (stack.length > 0) {
    repairs.push("truncated");
    let text = out.join("");
    // Drop a dangling separator or a key with no value before closing.
    for (let pass = 0; pass < 4; pass++) {
      const trimmed = text.replace(/\s+$/, "");
      if (trimmed.endsWith(",")) {
        text = trimmed.slice(0, -1);
        continue;
      }
      if (trimmed.endsWith(":")) {
        const cut = Math.max(trimmed.lastIndexOf(","), trimmed.lastIndexOf("{"));
        text = cut > 0 ? trimmed.slice(0, cut) : trimmed.slice(0, -1);
        continue;
      }
      if (trimmed.endsWith("[") || trimmed.endsWith("{")) {
        text = trimmed.slice(0, -1);
        stack.pop();
        continue;
      }
      text = trimmed;
      break;
    }
    out.length = 0;
    out.push(text);
    while (stack.length > 0) out.push(stack.pop()!);
  }

  const repairedText = out.join("").trim();
  return { text: repairedText || "{}", repairs: [...new Set(repairs)] };
}



// ---- text-format tool calls --------------------------------------------------
// Some models write the call into content instead of tool_calls: Hermes/Qwen2.5
// `<tool_call>{"name":…,"arguments":{…}}</tool_call>`, Qwen3-Coder
// `<tool_call><function=NAME><parameter=KEY>VALUE…</tool_call>`, the bare
// `<function=NAME>{…}</function>`, the element form
// `<Function name="NAME">{…}</Function>` (body may instead hold
// `<parameter name="KEY">VALUE</parameter>` children), and the Anthropic XML
// form `<function_calls><invoke name="NAME">…</invoke></function_calls>`.
// Tag matching is case-insensitive; these are lifted into structured calls.
export const TEXT_CALL_OPENERS = ["<tool_call>", "<function=", "<function_calls>", "<function ", "<invoke ", "<|tool_call>"];



export interface TextToolCall { name: string; arguments: Record<string, unknown> }



// ---- the <|tool_call> dialect -------------------------------------------------
// Another family writes calls with special-token furniture:
//   <|tool_call>call:fs_patch{edits:[{new:<|"|>…<|"|>,old:<|"|>…<|"|>}],path:<|"|>index.html<|"|>}
// An optional `call:` prefix, the bare function name, then an object literal
// whose strings are delimited by <|"|> instead of quotes (string content may
// contain anything, including newlines and braces). The blob is rebuilt into
// JSON by re-quoting the delimited segments, then passed through the same
// repair normaliser as every other dialect.

export const BAR_STRING_DELIM = '<|"|>';

export function parseBarToolCalls(text: string): { calls: TextToolCall[]; spans: Array<[number, number]> } {
  const calls: TextToolCall[] = [];
  const spans: Array<[number, number]> = [];
  const opener = /<\|tool_call\|?>/gi;
  for (let m; (m = opener.exec(text));) {
    let i = m.index + m[0].length;
    const skipWs = () => { while (i < text.length && /\s/.test(text[i])) i++; };
    skipWs();
    if (text.slice(i, i + 5).toLowerCase() === "call:") { i += 5; skipWs(); }
    const nameMatch = /^[A-Za-z][\w.-]*/.exec(text.slice(i, i + 80));
    if (!nameMatch) continue;
    const name = nameMatch[0];
    i += name.length;
    skipWs();
    if (text[i] !== "{") continue;
    // Brace-match from the opening {, aware of <|"|>-delimited strings so
    // braces inside string content do not move the depth.
    const start = i;
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      if (text.startsWith(BAR_STRING_DELIM, j)) { inStr = !inStr; j += BAR_STRING_DELIM.length - 1; continue; }
      if (inStr) continue;
      const ch = text[j];
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) { end = j + 1; break; }
      }
    }
    const blobEnd = end < 0 ? text.length : end;
    const blob = text.slice(start, blobEnd);
    const parts = blob.split(BAR_STRING_DELIM);
    let rebuilt = "";
    for (let k = 0; k < parts.length; k++) rebuilt += k % 2 === 1 ? JSON.stringify(parts[k]) : parts[k];
    let args: unknown = null;
    try { args = JSON.parse(repairJsonText(rebuilt).text); } catch { args = null; }
    if (!isPlainObject(args)) continue; // not a liftable call — leave the text untouched
    let spanEnd = blobEnd;
    const tail = /^\s*<\|\/tool_call\|?>/.exec(text.slice(spanEnd, spanEnd + 24));
    if (tail) spanEnd += tail[0].length;
    calls.push({ name, arguments: args as Record<string, unknown> });
    spans.push([m.index, spanEnd]);
    opener.lastIndex = spanEnd;
  }
  return { calls, spans };
}



export function textArgValue(raw: string): unknown {
  const v = raw.replace(/^\s*\n|\n\s*$/g, "").trim();
  if (/^(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)$/i.test(v) || /^[[{]/.test(v)) {
    try { return JSON.parse(v); } catch { /* keep the string */ }
  }
  return v;
}



/** Parse every text-format call in `text`; null when none parse. `rest` is the prose outside them. */
export function parseTextToolCalls(text: string): { calls: TextToolCall[]; rest: string } | null {
  // The <|tool_call> dialect is extracted first and its spans blanked
  // (length-preserving, so every index below still lines up); the XML/JSON
  // forms then run over what remains.
  const bar = parseBarToolCalls(text);
  let working = text;
  if (bar.spans.length) {
    const chars = text.split("");
    for (const [s, e] of bar.spans) for (let i = s; i < e; i++) if (chars[i] !== "\n") chars[i] = " ";
    working = chars.join("");
  }
  const positioned: Array<{ at: number; call: TextToolCall }> = bar.calls.map((call, k) => ({ at: bar.spans[k][0], call }));
  const block = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)|<function=([^>\s]+)>\s*([\s\S]*?)\s*(?:<\/function>|(?=<function=)|$)|<function_calls>\s*([\s\S]*?)\s*(?:<\/function_calls>|$)|<function\s([^>]*?)>\s*([\s\S]*?)\s*(?:<\/function>|$)|<invoke\s([^>]*?)>\s*([\s\S]*?)\s*(?:<\/invoke>|$)/gi;
  let rest = "";
  let last = 0;
  for (let m; (m = block.exec(working));) {
    if (m[0] === "") { block.lastIndex++; continue; }
    const parsed = m[1] !== undefined ? parseCallBody(m[1])
      : m[2] !== undefined ? parseFunctionBody(m[2], m[3])
      : m[4] !== undefined ? parseInvokeList(m[4])
      : m[5] !== undefined ? parseElementBody(m[5], m[6])
      : parseInvokeBody(m[7], m[8]);
    if (!parsed.length) continue;
    for (const call of parsed) positioned.push({ at: m.index, call });
    rest += working.slice(last, m.index);
    last = m.index + m[0].length;
  }
  if (!positioned.length) return null;
  rest += working.slice(last);
  positioned.sort((a, b) => a.at - b.at);
  return { calls: positioned.map((p) => p.call), rest: rest.trim() };
}



export function tagAttr(attrs: string, key: string): string {
  const m = attrs.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"|${key}\\s*=\\s*'([^']*)'|${key}\\s*=\\s*([^\\s>]+)`, "i"));
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}



export function parseInvokeList(body: string): TextToolCall[] {
  const out: TextToolCall[] = [];
  for (const m of body.matchAll(/<invoke\s([^>]*?)>\s*([\s\S]*?)\s*(?:<\/invoke>|$)/gi)) out.push(...parseInvokeBody(m[1], m[2]));
  return out;
}



export function parseInvokeBody(attrs: string, body: string): TextToolCall[] {
  const name = tagAttr(attrs, "name");
  return name ? parseAttributedBody(name, attrs, body) : [];
}



export function parseElementBody(attrs: string, body: string): TextToolCall[] {
  const name = tagAttr(attrs, "name");
  return name ? parseAttributedBody(name, attrs, body) : [];
}



// Shared tail for the attribute forms: an `arguments` attribute holding a
// JSON object wins when the body yields nothing; otherwise the body is
// parameters or a JSON object, exactly like the <function=NAME> form.
export function parseAttributedBody(name: string, attrs: string, body: string): TextToolCall[] {
  if (body.trim()) {
    const fromBody = parseFunctionBody(name, body);
    if (fromBody.length) return fromBody;
  }
  const raw = tagAttr(attrs, "arguments");
  if (raw) {
    try { const j = JSON.parse(raw); if (isPlainObject(j)) return [{ name, arguments: j as Record<string, unknown> }]; } catch { /* not JSON */ }
  }
  return parseFunctionBody(name, body);
}



export function parseCallBody(body: string): TextToolCall[] {
  const fn = body.match(/^<function=([^>\s]+)>\s*([\s\S]*?)\s*(?:<\/function>\s*)?$/i);
  if (fn) return parseFunctionBody(fn[1], fn[2]);
  try {
    const j = JSON.parse(body);
    const one = (o: Record<string, unknown>): TextToolCall | null => {
      const name = typeof o.name === "string" ? o.name : typeof (o.function as Json)?.name === "string" ? String((o.function as Json).name) : "";
      let args = o.arguments ?? o.parameters ?? (o.function as Json)?.arguments ?? {};
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { return null; } }
      return name && isPlainObject(args) ? { name, arguments: args as Record<string, unknown> } : null;
    };
    const list = (Array.isArray(j) ? j : [j]).filter(isPlainObject).map(one);
    return list.every(Boolean) ? (list as TextToolCall[]) : [];
  } catch {
    return [];
  }
}



export function parseFunctionBody(name: string, body: string): TextToolCall[] {
  const params = [...body.matchAll(/<parameter\s*(?:=\s*([^>\s]+)|name\s*=\s*"([^"]+)"|name\s*=\s*'([^']+)'|name\s*=\s*([^>\s]+))\s*>([\s\S]*?)(?=<\/parameter>|<parameter[\s=>]|<\/function>|<\/tool_call>|<\/invoke>|$)(?:<\/parameter>)?/gi)]
    .map((p) => [p[1] ?? p[2] ?? p[3] ?? p[4], p[5]] as const);
  if (params.length) return [{ name, arguments: Object.fromEntries(params.map(([k, v]) => [k, textArgValue(v)])) }];
  const trimmed = body.trim();
  if (!trimmed) return [{ name, arguments: {} }];
  try { const j = JSON.parse(trimmed); return isPlainObject(j) ? [{ name, arguments: j }] : []; } catch { return []; }
}
