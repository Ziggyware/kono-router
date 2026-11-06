// The edit engine behind fs_patch: literal, verifiable, and explicit about how
// every replacement landed.
//
// Replacement text is inserted verbatim (no `$&`-style patterns). When an
// anchor misses exactly, three recoveries are tried in order and each one is
// reported, never silent: line-ending translation (CRLF files edited with LF
// anchors), whitespace-insensitive matching with the replacement re-indented to
// the file's indentation, and — if both fail — a precise miss report pointing
// at the closest line and the first diverging line, so the next attempt can be
// corrected without re-reading the whole file.

export interface StringEdit { old: string; new: string; replace_all?: boolean }
export interface LineEdit { start_line: number; end_line: number; new: string }
export type Edit = StringEdit | LineEdit;

export interface EditReport {
  edit: number;
  replacements: number;
  /** "exact" | "crlf" | "whitespace" | "lines" */
  match: string;
  line: number;
}

const isLineEdit = (e: Edit): e is LineEdit => typeof (e as LineEdit).start_line === "number";

/** Lines in `text` (1-based) at which each offset falls. */
const lineAt = (text: string, offset: number): number => {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) n++;
  return n;
};

const occurrences = (hay: string, needle: string): number[] => {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex matching `old` with whitespace made flexible: any whitespace run may
 *  differ, and whitespace may appear or vanish next to punctuation. Between two
 *  word tokens at least one space is still required, so `return x` never
 *  matches `returnx`. */
function looseRegex(old: string): RegExp | null {
  const tokens = old.trim().match(/\w+|\s+|[^\w\s]/g);
  if (!tokens) return null;
  let src = "";
  let prev: string | null = null, gap = false;
  for (const t of tokens) {
    if (/^\s/.test(t)) { gap = true; continue; }
    if (prev !== null) src += /^\w/.test(prev) && /^\w/.test(t) ? (gap ? "\\s+" : "") : "\\s*";
    src += escapeRe(t);
    prev = t; gap = false;
  }
  return new RegExp(src, "g");
}

const indentOf = (line: string): string => line.match(/^[ \t]*/)![0];

/** Re-indent replacement lines from the anchor's indentation scheme to the
 *  file's. Indent widths seen on both sides map directly (anchor line ↔ the
 *  file line it matched); other widths scale by the ratio of the two schemes,
 *  so a 2-space anchor edited into a 4-space file comes out 4-space. */
function reindent(next: string, anchor: string, region: string): string {
  const a = anchor.split("\n").filter((l) => l.trim()), f = region.split("\n").filter((l) => l.trim());
  if (!a.length || a.length !== f.length) return next;
  const map = new Map<number, string>();
  for (let i = 0; i < a.length; i++) if (!map.has(indentOf(a[i]).length)) map.set(indentOf(a[i]).length, indentOf(f[i]));
  const aw = a.map((l) => indentOf(l).length), fw = f.map((l) => indentOf(l).length);
  let scale = 1;
  for (let i = 1; i < a.length; i++) if (aw[i] !== aw[0]) { scale = (fw[i] - fw[0]) / (aw[i] - aw[0]); break; }
  if (!(scale > 0)) scale = 1;
  const unit = f.map(indentOf).find((x) => x)?.[0] ?? " ";
  return next.split("\n").map((l, i) => {
    if (i === 0 || !l.trim()) return l;
    const w = indentOf(l).length;
    const ind = map.get(w) ?? unit.repeat(Math.max(0, Math.round(fw[0] + (w - aw[0]) * scale)));
    return ind + l.trimStart();
  }).join("\n");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a), B = bigrams(b);
  let both = 0;
  for (const [g, n] of A) both += Math.min(n, B.get(g) ?? 0);
  return (2 * both) / (a.length - 1 + b.length - 1);
}

const norm = (l: string): string => l.trim().replace(/\s+/g, " ");

/** Why an anchor did not match, phrased so the model can repair it directly. */
export function explainMiss(content: string, old: string): string {
  const lines = content.split("\n");
  const want = old.replace(/\r\n/g, "\n").split("\n");
  const first = want.findIndex((l) => l.trim());
  if (first < 0) return "anchor is only whitespace";
  const head = norm(want[first]);
  // Best run: a file line equal to the anchor's first line, followed as far as it agrees.
  let best = { at: -1, agree: 0 };
  for (let i = 0; i < lines.length; i++) {
    if (norm(lines[i]) !== head) continue;
    let k = 0;
    while (first + k < want.length && i + k < lines.length && norm(lines[i + k]) === norm(want[first + k])) k++;
    if (k > best.agree) best = { at: i, agree: k };
  }
  if (best.at >= 0) {
    const k = first + best.agree;
    if (k >= want.length) return `anchor text exists at line ${best.at + 1} but differs in characters that are not whitespace-only`;
    const fileLine = lines[best.at + best.agree];
    return `anchor's first line matches line ${best.at + 1}, but anchor line ${k + 1} ${JSON.stringify(clip(want[k]))} differs from file line ${best.at + best.agree + 1} ${JSON.stringify(clip(fileLine ?? "<end of file>"))}`;
  }
  let top = { i: -1, s: 0 };
  for (let i = 0; i < lines.length; i++) {
    const s = similarity(norm(lines[i]), head);
    if (s > top.s) top = { i, s };
  }
  if (top.i >= 0 && top.s >= 0.5) return `no line matches the anchor's first line; closest is line ${top.i + 1} (${Math.round(top.s * 100)}% similar): ${JSON.stringify(clip(lines[top.i]))}`;
  return "nothing in the file resembles the anchor; the file may have changed — fs_read it again";
}
const clip = (s: string): string => (s.length > 120 ? s.slice(0, 119) + "…" : s);

/** Apply edits to `content`. Throws with an actionable message; returns the new
 *  text and how each edit landed. String edits apply in order to the evolving
 *  text; line edits all refer to the original numbering. */
export function applyEdits(content: string, edits: Edit[]): { text: string; reports: EditReport[] } {
  if (!edits.length) throw new Error("no edits");
  const lineEdits = edits.filter(isLineEdit);
  if (lineEdits.length && lineEdits.length !== edits.length) throw new Error("do not mix line-range edits with old/new edits in one call");
  if (lineEdits.length) return applyLineEdits(content, lineEdits);

  let text = content;
  const reports: EditReport[] = [];
  const crlf = text.includes("\r\n");
  for (const [i, e] of (edits as StringEdit[]).entries()) {
    let old = String(e.old ?? ""), next = String(e.new ?? "");
    if (!old) throw new Error(`edit ${i}: old is empty (to insert, anchor on a neighbouring line and repeat it in new)`);
    let match = "exact";
    let hits = occurrences(text, old);
    if (!hits.length && crlf && !old.includes("\r") && old.includes("\n")) {
      const o = old.replace(/\n/g, "\r\n");
      const h = occurrences(text, o);
      if (h.length) { old = o; next = next.replace(/\r?\n/g, "\r\n"); hits = h; match = "crlf"; }
    }
    if (hits.length) {
      if (hits.length > 1 && e.replace_all !== true) {
        throw new Error(`edit ${i}: anchor matches ${hits.length} places (lines ${hits.slice(0, 8).map((h) => lineAt(text, h)).join(", ")}); include more surrounding lines or set replace_all`);
      }
      const at = e.replace_all === true ? hits : [hits[0]];
      let out = "", from = 0;
      for (const h of at) { out += text.slice(from, h) + next; from = h + old.length; }
      reports.push({ edit: i, replacements: at.length, match, line: lineAt(text, at[0]) });
      text = out + text.slice(from);
      continue;
    }
    // Whitespace-insensitive: unique match required unless replace_all.
    const re = looseRegex(old);
    const found = re ? [...text.matchAll(re)] : [];
    if (found.length === 1 || (found.length > 1 && e.replace_all === true)) {
      const lead = old.match(/^\s*/)![0], tail = old.match(/\s*$/)![0];
      // The anchor as it sits on its lines (first line's indentation included).
      const anchor = lead.slice(lead.lastIndexOf("\n") + 1) + old.trim();
      let out = "", from = 0;
      for (const m of found) {
        const start = m.index!;
        const lineStart = text.lastIndexOf("\n", start - 1) + 1;
        const region = text.slice(lineStart, start + m[0].length).replace(/\r/g, "");
        // The match excludes the anchor's outer whitespace, so the replacement drops it too.
        let repl = next.startsWith(lead) ? next.slice(lead.length) : next.replace(/^[ \t]*/, "");
        if (tail && repl.endsWith(tail)) repl = repl.slice(0, -tail.length);
        repl = reindent(repl.replace(/\r\n/g, "\n"), anchor, /^[ \t]*$/.test(text.slice(lineStart, start)) ? region : indentOf(region) + region.slice(start - lineStart));
        if (crlf) repl = repl.replace(/\n/g, "\r\n");
        out += text.slice(from, start) + repl;
        from = start + m[0].length;
      }
      reports.push({ edit: i, replacements: found.length, match: "whitespace", line: lineAt(text, found[0].index!) });
      text = out + text.slice(from);
      continue;
    }
    if (found.length > 1) {
      throw new Error(`edit ${i}: anchor not found exactly; ignoring whitespace it matches ${found.length} places (lines ${found.slice(0, 8).map((m) => lineAt(text, m.index!)).join(", ")}) — include more context`);
    }
    throw new Error(`edit ${i}: anchor not found — ${explainMiss(text, old)}`);
  }
  return { text, reports };
}

function applyLineEdits(content: string, edits: LineEdit[]): { text: string; reports: EditReport[] } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const sorted = edits.map((e, i) => ({ ...e, i })).sort((a, b) => b.start_line - a.start_line);
  for (const e of sorted) {
    if (!Number.isInteger(e.start_line) || !Number.isInteger(e.end_line)) throw new Error(`edit ${e.i}: start_line and end_line must be integers`);
    if (e.start_line < 1 || e.start_line > lines.length + 1) throw new Error(`edit ${e.i}: start_line ${e.start_line} is outside 1..${lines.length + 1}`);
    if (e.end_line < e.start_line - 1 || e.end_line > lines.length) throw new Error(`edit ${e.i}: end_line ${e.end_line} is outside ${e.start_line - 1}..${lines.length} (end_line = start_line - 1 inserts before start_line)`);
  }
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].end_line >= sorted[k - 1].start_line) throw new Error(`edits ${sorted[k].i} and ${sorted[k - 1].i} overlap`);
  }
  const reports: EditReport[] = [];
  for (const e of sorted) {
    const repl = String(e.new ?? "");
    lines.splice(e.start_line - 1, e.end_line - e.start_line + 1, ...(repl === "" ? [] : repl.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")));
    reports.push({ edit: e.i, replacements: 1, match: "lines", line: e.start_line });
  }
  return { text: lines.join(eol), reports: reports.sort((a, b) => a.edit - b.edit) };
}

/** A content hash given back by the model, compared leniently: hashes get
 *  truncated in transcripts, so any prefix of 8+ characters identifies it. */
export function shaMatches(expected: string, actual: string): boolean {
  const e = expected.trim();
  return e.length >= 8 && actual.startsWith(e);
}
