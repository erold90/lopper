/**
 * lopper: compacts a Claude Code conversation without summarizing it.
 *
 * Every word you and Claude wrote stays verbatim and in order. What gets cut is
 * old tool output: results are trimmed to head + tail, results a later call made
 * obsolete are replaced by a note, and long inputs of old calls are shortened. No
 * call ever disappears, and every cut leaves a `[lopper: …]` note saying so.
 *
 * Pure and deterministic: no network, no model, no Node APIs, so the same code
 * runs in the function-hook environment and in the tests.
 */

export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** The result as the model read it (Claude Code mirrors it here). */
  text?: string;
  isError?: true;
}

export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError: boolean;
}

/** One transcript row: the shape of Claude Code's `SessionMessage`. */
export interface Message {
  role: 'user' | 'assistant';
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
  handle?: string;
}

/** Media a tool result carried, which a rebuilt message cannot keep. */
export interface Media {
  images: number;
  documents: number;
}

/**
 * Context the engine keeps outside the transcript rows (a skill's instructions, a
 * file attached with @, a pasted image), to put back in front of row `before`.
 */
export interface Extra {
  before: number;
  kind: 'instructions' | 'attachment' | 'media';
  text: string;
}

export interface Cut {
  /** Characters kept from the start. */
  head: number;
  /** Characters kept from the end. */
  tail: number;
}

export interface Options {
  /** The newest tokens (estimated): results there stay whole. */
  recentTokens: number;
  /** The tokens before the recent ones get a light cut (`middle`); older ones `old`. */
  middleTokens: number;
  middle: Cut;
  old: Cut;
  /** Errors matter more: their head is multiplied by this. */
  errorHeadFactor: number;
  /** Subagent reports are summaries already: cut them little. */
  agent: Cut;
  /** Outside the recent zone, an input string longer than this is shortened. */
  inputMax: number;
  /** Even a recent result longer than this is cut. */
  huge: number;
  /** Media per `tool_use_id`: it all goes, and a note says so. */
  media?: ReadonlyMap<string, Media>;
  /** Hidden context to put back (see `Extra`). */
  extras?: readonly Extra[];
}

export type Zone = 'recent' | 'middle' | 'old';

export type Action = 'kept' | 'trimmed' | 'superseded';

export interface Decision {
  tool_use_id: string;
  tool: string;
  zone: Zone;
  action: Action;
  /** For `superseded`: what made the result obsolete. */
  reason?: string;
  charsBefore: number;
  charsAfter: number;
  inputTrimmed: boolean;
  media: number;
}

export interface Stats {
  messagesBefore: number;
  messagesAfter: number;
  /** Rows left empty (thinking-only or media-only) and dropped. */
  emptyDropped: number;
  charsBefore: number;
  charsAfter: number;
  calls: number;
  kept: number;
  trimmed: number;
  superseded: number;
  inputsTrimmed: number;
  mediaRemoved: number;
  /** Hidden context put back: skill instructions, attached files, media notes. */
  extras: number;
  ms: number;
}

export interface Result {
  messages: Message[];
  decisions: Decision[];
  stats: Stats;
}

/**
 * Characters per token, for estimates. Measured on Opus 5 in September 2026: 2.16
 * on code with comments, 1.7 on `ls -la` output, 2.07 on a real conversation, 2.4
 * on a JavaScript repository. Kept low on purpose so the estimate errs high.
 */
export const CHARS_PER_TOKEN = 2;

export const DEFAULT_OPTIONS: Options = {
  recentTokens: 40_000,
  middleTokens: 120_000,
  middle: { head: 2_500, tail: 800 },
  old: { head: 900, tail: 300 },
  errorHeadFactor: 2,
  agent: { head: 4_000, tail: 1_000 },
  inputMax: 1_500,
  huge: 60_000,
};

/** The second pass, when the first is not enough: tighter cuts, fewer recent tokens. */
export function tighter(base: Options): Options {
  return {
    ...base,
    recentTokens: Math.round(base.recentTokens / 2),
    middleTokens: Math.round(base.middleTokens / 2),
    middle: base.old,
    old: { head: 300, tail: 120 },
    agent: { head: 1_500, tail: 500 },
    inputMax: 400,
    huge: 20_000,
  };
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Every note starts with this. The word joiner (U+2060) after the colon is
 * invisible and never typed by hand, so a note quoted in a file or a page read
 * later (lopper's own README has one) is never mistaken for one of lopper's own.
 */
const NOTE = '[lopper:\u2060';

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** Characters of text, inputs and results a message holds. */
export function messageChars(m: Message): number {
  let total = m.text.length;
  for (const use of m.toolUses) total += safeJson(use.input).length;
  for (const r of m.toolResults ?? []) total += r.text.length;
  return total;
}

/** A cut that never splits a surrogate pair (emoji and the like). */
function takeHead(text: string, end: number): string {
  let n = Math.max(0, Math.min(end, text.length));
  const code = text.charCodeAt(n - 1);
  if (n > 0 && code >= 0xd800 && code <= 0xdbff) n -= 1;
  return text.slice(0, n);
}

function takeTail(text: string, count: number): string {
  if (count <= 0) return '';
  let from = Math.max(0, text.length - count);
  const code = text.charCodeAt(from);
  if (from < text.length && code >= 0xdc00 && code <= 0xdfff) from += 1;
  return text.slice(from);
}

/** Ends the head at the last line break, if that loses less than a fifth of it. */
function headToLine(text: string, head: number): number {
  const at = text.lastIndexOf('\n', head);
  return at >= head * 0.8 ? at + 1 : head;
}

/** Starts the tail at the first line break, if that loses less than a fifth of it. */
function tailToLine(text: string, tail: number): number {
  const from = text.length - tail;
  const at = text.indexOf('\n', from);
  return at !== -1 && at - from <= tail * 0.2 ? text.length - at - 1 : tail;
}

/** A line that reports a failure: `Error: …`, `TypeError: …`, `fatal: …`, `npm ERR!`, `FAIL …`. */
const ERROR_LINE =
  /^\s*(?:error|fatal|panic|traceback|fail(?:ed|ure)?|npm ERR!)\b|\b\w*(?:error|exception)\b:|command not found|permission denied|no such file or directory|[✖✗]/i;
const PATH = /(?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]+)+/g;
const URL = /https?:\/\/[^\s"'<>)\]]+/g;
/** Bounds the scan for salvage: the regexes stay linear, this keeps them cheap. */
const SALVAGE_SCAN = 200_000;

/**
 * From the part being cut, keeps the little the model may want to know was
 * there: error lines, paths, URLs. At most `limit` characters.
 */
export function salvage(removed: string, limit = 400): string {
  const text = removed.length > SALVAGE_SCAN ? removed.slice(0, SALVAGE_SCAN) : removed;
  const pieces: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  const add = (piece: string): boolean => {
    const p = piece.trim();
    if (!p || seen.has(p)) return true;
    if (used + p.length + 3 > limit) return false;
    seen.add(p);
    pieces.push(p);
    used += p.length + 3;
    return true;
  };
  let errors = 0;
  for (const line of text.split('\n')) {
    if (errors >= 3) break;
    if (line.includes(NOTE)) continue;
    if (ERROR_LINE.test(line)) {
      errors += 1;
      if (!add(line.length > 140 ? `${takeHead(line.trim(), 139)}…` : line)) break;
    }
  }
  let others = 0;
  for (const found of [...text.matchAll(URL), ...text.matchAll(PATH)]) {
    if (others >= 8) break;
    const piece = found[0].length > 100 ? `${takeHead(found[0], 99)}…` : found[0];
    if (!add(piece)) break;
    others += 1;
  }
  return pieces.join(' · ');
}

const CUT_NOTE =
  /\[lopper:\u2060 (\d+) chars of this result removed here to save context, not an error(?:; they included: ([^\n]*?))?\. Run the tool again if you need them\]\n?/;

/**
 * Head + note + tail. Short text, or a cut that would not save anything, stays as
 * is. `keep` salvages error lines, paths and URLs from the part cut; a file's own
 * content (a Read) gets none, since reading it again gives it all back.
 */
export function cut(text: string, limits: Cut, keep = true): string {
  // A second compaction meets its own earlier note: cut around it and add up.
  const earlier = CUT_NOTE.exec(text);
  let before = text;
  let after = '';
  let alreadyCut = 0;
  let alreadySaved = '';
  if (earlier) {
    before = text.slice(0, earlier.index);
    after = text.slice(earlier.index + earlier[0].length);
    alreadyCut = Number(earlier[1]);
    alreadySaved = earlier[2] ?? '';
  }
  const room = limits.head + limits.tail + 200;
  if (!earlier && text.length <= room) return text;
  const headSource = before;
  const tailSource = earlier ? after : before;
  const headLength = Math.min(headSource.length, headToLine(headSource, limits.head));
  const tailLength = limits.tail > 0 ? Math.min(tailSource.length, tailToLine(tailSource, limits.tail)) : 0;
  const head = takeHead(headSource, headLength);
  const tail = earlier ? takeTail(after, tailLength) : takeTail(before.slice(head.length), tailLength);
  const removedNow = earlier
    ? before.slice(head.length) + after.slice(0, after.length - tail.length)
    : before.slice(head.length, before.length - tail.length);
  const removed = alreadyCut + removedNow.length;
  if (removed === 0) return text;
  const fresh = keep ? salvage(removedNow, Math.max(0, 400 - alreadySaved.length)) : '';
  const saved = [alreadySaved, fresh].filter(Boolean).join(' · ');
  const note = `${NOTE} ${removed} chars of this result removed here to save context, not an error${
    saved ? `; they included: ${saved}` : ''
  }. Run the tool again if you need them]`;
  // The note follows the head directly (the head usually ends at a line break),
  // so a later cut can find it and give back exactly what surrounds it.
  const out = `${head}${note}${tail ? `\n${tail}` : ''}`;
  return out.length < text.length ? out : text;
}

/** How a Read or Write names its file. */
function pathOf(use: ToolUse): string | undefined {
  const p = use.input['file_path'] ?? use.input['notebook_path'];
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}

/** Stable JSON, keys sorted, so equal inputs compare equal. */
function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return safeJson(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${sortedJson((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/**
 * Tools whose result depends on the input alone, not on the session's state (a
 * Bash `ls` depends on the working directory): only these can be superseded by a
 * later identical call.
 */
const REPEATABLE = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']);
/** These search the working directory unless given a `path`, and a `cd` in Bash moves it. */
const NEEDS_PATH = new Set(['Grep', 'Glob', 'LS']);

/** A result that points back to an earlier read instead of carrying the file. */
function isStub(text: string): boolean {
  return (
    text.startsWith('File unchanged since last read') ||
    text.startsWith('Wasted call') ||
    text.startsWith('<system-reminder>This file is already in your context')
  );
}

/** A result that does not carry the whole output (Claude Code cut or spilled it). */
function isPartial(text: string): boolean {
  return text.includes('[Truncated: PARTIAL view') || text.startsWith('Output too large');
}

interface Keys {
  /** Keys a later call can supersede this one by. */
  reads: string[];
  /** Keys this call supersedes earlier calls by. */
  produces: string[];
}

function keysOf(use: ToolUse, result: ToolResult): Keys {
  const reads: string[] = [];
  const produces: string[] = [];
  const substantive = !result.isError && !isStub(result.text) && !isPartial(result.text);
  const anchored = !NEEDS_PATH.has(use.tool) || (typeof use.input['path'] === 'string' && use.input['path'].startsWith('/'));
  if (REPEATABLE.has(use.tool) && anchored) {
    const same = `same:${use.tool}:${sortedJson(use.input)}`;
    reads.push(same);
    if (substantive) produces.push(same);
  }
  const path = pathOf(use);
  if (path && use.tool === 'Read') {
    reads.push(`file:${path}`);
    const whole = !['offset', 'limit', 'pages'].some((k) => use.input[k] !== undefined);
    if (whole && substantive) produces.push(`file:${path}`);
  }
  // After a whole-file rewrite, every earlier read of it is stale.
  if (path && use.tool === 'Write' && !result.isError) produces.push(`file:${path}`);
  return { reads, produces };
}

function describeLater(later: Call): string {
  const use = later.use;
  const path = use ? pathOf(use) : undefined;
  if (path && use?.tool === 'Write') return `${path} was rewritten later`;
  if (path && use?.tool === 'Read') return `${path} was read again later`;
  return `the same ${use?.tool ?? 'call'} ran again later`;
}

const AGENTS = new Set(['Agent', 'Task']);
/** Tools whose result is a file's own content: nothing to salvage from it. */
const READS_FILES = new Set(['Read', 'NotebookRead']);

function limitsFor(zone: Zone, tool: string, error: boolean, o: Options): Cut | undefined {
  if (zone === 'recent') return undefined;
  const base = zone === 'middle' ? o.middle : o.old;
  let limits = base;
  if (AGENTS.has(tool)) {
    limits = { head: Math.max(base.head, o.agent.head), tail: Math.max(base.tail, o.agent.tail) };
  }
  if (error) limits = { head: Math.round(limits.head * o.errorHeadFactor), tail: limits.tail };
  return limits;
}

const FIELD_NOTE = /…\[lopper:\u2060 (\d+) chars of this field removed to save context\]$/;

/** Shortens the long strings of an input; returns the same object when there is nothing to do. */
function trimInput(value: unknown, max: number, depth = 0): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const keep = Math.max(120, Math.round(max / 3));
    const earlier = FIELD_NOTE.exec(value);
    const body = earlier ? value.slice(0, earlier.index) : value;
    const already = earlier ? Number(earlier[1]) : 0;
    if (earlier ? body.length <= keep : value.length <= max) return { value, changed: false };
    const head = takeHead(body, keep);
    return {
      value: `${head}…${NOTE} ${already + body.length - head.length} chars of this field removed to save context]`,
      changed: true,
    };
  }
  if (value === null || typeof value !== 'object' || depth >= 4) return { value, changed: false };
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const r = trimInput(v, max, depth + 1);
      changed ||= r.changed;
      return r.value;
    });
    return { value: changed ? next : value, changed };
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const r = trimInput(v, max, depth + 1);
    changed ||= r.changed;
    next[k] = r.value;
  }
  return { value: changed ? next : value, changed };
}

function resolve(options: Partial<Options>): Options {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const number = (v: number, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  return {
    ...o,
    recentTokens: number(o.recentTokens, DEFAULT_OPTIONS.recentTokens),
    middleTokens: number(o.middleTokens, DEFAULT_OPTIONS.middleTokens),
    errorHeadFactor: number(o.errorHeadFactor, DEFAULT_OPTIONS.errorHeadFactor),
    inputMax: Math.max(200, number(o.inputMax, DEFAULT_OPTIONS.inputMax)),
    huge: Math.max(2_000, number(o.huge, DEFAULT_OPTIONS.huge)),
  };
}

interface Call {
  tool_use_id: string;
  use?: ToolUse;
  useRow: number;
  result?: ToolResult;
  resultRow: number;
}

function collectCalls(messages: readonly Message[]): Call[] {
  const byId = new Map<string, Call>();
  const order: Call[] = [];
  const take = (tool_use_id: string, row: number): Call => {
    let c = byId.get(tool_use_id);
    if (!c) {
      c = { tool_use_id, useRow: row, resultRow: -1 };
      byId.set(tool_use_id, c);
      order.push(c);
    }
    return c;
  };
  messages.forEach((m, i) => {
    for (const use of m.toolUses) {
      const c = take(use.tool_use_id, i);
      c.use = use;
      c.useRow = i;
    }
    for (const r of m.toolResults ?? []) {
      const c = take(r.tool_use_id, i);
      c.result = r;
      c.resultRow = i;
    }
  });
  return order;
}

function mediaNote(tool: string, path: string | undefined, media: Media): string {
  const parts: string[] = [];
  if (media.images > 0) parts.push(media.images === 1 ? 'an image' : `${media.images} images`);
  if (media.documents > 0) parts.push(media.documents === 1 ? 'a document' : `${media.documents} documents`);
  const how = tool === 'Read' && path ? `read ${path} again` : 'run the tool again';
  return `${NOTE} removed ${parts.join(' and ')} from this result; ${how} if you need to see it]`;
}

function joinText(a: string, b: string): string {
  if (!a.trim()) return b;
  if (!b.trim()) return a;
  return `${a}\n\n${b}`;
}

/**
 * Claude Code hands a hook one row per block, but reads rebuilt rows as whole
 * messages, and pairs each tool call with the results in the very next message.
 * So rows go back as API messages: an assistant turn in one message (its text and
 * every call it made), then the results of those calls together, and nothing in
 * between. Left as separate rows, parallel calls lose their results: all but the
 * last get "Tool result missing due to internal error".
 */
export function regroup(rows: readonly Message[]): Message[] {
  const out: Message[] = [];
  /** The assistant message being built: one API response. */
  let current: Message | undefined;
  /** Its calls still waiting for their results. */
  const waiting = new Set<string>();
  /** The message collecting those results, right after `current`. */
  let results: Message | undefined;
  /** User text that arrived between calls and their results: it goes after them. */
  let held: Message[] = [];
  const release = () => {
    out.push(...held);
    held = [];
  };

  for (const row of rows) {
    if (row.role === 'assistant') {
      // Parallel calls can have a result recorded before the response lists its
      // last call (`A[a] A[b] U[rb] A[c] U[ra] U[rc]`): still the same response.
      const sameResponse =
        current !== undefined &&
        held.length === 0 &&
        (waiting.size > 0 || out[out.length - 1] === current);
      if (sameResponse && current) {
        current.text = joinText(current.text, row.text);
        current.toolUses = [...current.toolUses, ...row.toolUses];
      } else {
        // A new response: calls left waiting will not be answered after this.
        waiting.clear();
        results = undefined;
        release();
        current = { role: 'assistant', text: row.text, toolUses: [...row.toolUses] };
        out.push(current);
      }
      for (const use of row.toolUses) waiting.add(use.tool_use_id);
      continue;
    }
    const own = row.toolResults ?? [];
    const answers = own.filter((r) => waiting.has(r.tool_use_id));
    if (answers.length > 0) {
      if (!results) {
        results = { role: 'user', text: '', toolUses: [], toolResults: [] };
        out.push(results);
      }
      results.toolResults!.push(...answers);
      for (const r of answers) waiting.delete(r.tool_use_id);
      const rest = own.filter((r) => !answers.includes(r));
      if (row.text.trim() || rest.length > 0) {
        const extra: Message = { role: 'user', text: row.text, toolUses: [] };
        if (rest.length > 0) extra.toolResults = rest;
        held.push(extra);
      }
      if (waiting.size === 0) {
        results = undefined;
        current = undefined;
        release();
      }
      continue;
    }
    if (waiting.size > 0) {
      held.push({ ...row, toolUses: [...row.toolUses] });
      continue;
    }
    current = undefined;
    out.push({ ...row, toolUses: [...row.toolUses] });
  }
  release();
  return out;
}

/**
 * Prunes the conversation. Every message comes back rebuilt, without its
 * `handle`: Claude Code then writes them after the compaction point, so a
 * `--resume` finds the pruned conversation rather than the old one.
 */
export function prune(messages: readonly Message[], options: Partial<Options> = {}): Result {
  const started = Date.now();
  const o = resolve(options);
  const n = messages.length;

  // Characters that come after each row: how old it is.
  const after: number[] = new Array<number>(n).fill(0);
  let running = 0;
  for (let i = n - 1; i >= 0; i--) {
    after[i] = running;
    running += messageChars(messages[i]!);
  }
  const charsBefore = running + (o.extras ?? []).reduce((s, x) => s + x.text.length, 0);
  const recentLimit = o.recentTokens * CHARS_PER_TOKEN;
  const middleLimit = recentLimit + o.middleTokens * CHARS_PER_TOKEN;
  const zoneOf = (row: number): Zone => {
    const d = after[Math.min(Math.max(row, 0), n - 1)] ?? 0;
    return d < recentLimit ? 'recent' : d < middleLimit ? 'middle' : 'old';
  };

  const calls = collectCalls(messages);
  // Results the model has not read yet: those of the last response's calls, and
  // anything after it. They are the working set of the turn in progress, and
  // cutting them would leave the model reporting on output it never saw.
  const unreadIds = new Set<string>();
  const shape = regroup(messages);
  let lastResponse = -1;
  shape.forEach((m, i) => {
    if (m.role === 'assistant') lastResponse = i;
  });
  if (lastResponse >= 0) {
    for (const use of shape[lastResponse]!.toolUses) unreadIds.add(use.tool_use_id);
    for (const m of shape.slice(lastResponse + 1)) for (const r of m.toolResults ?? []) unreadIds.add(r.tool_use_id);
  } else {
    for (const m of shape) for (const r of m.toolResults ?? []) unreadIds.add(r.tool_use_id);
  }
  const unread = (c: Call): boolean => c.result !== undefined && unreadIds.has(c.tool_use_id);

  // Superseded: walk from the newest call, remembering what was produced later.
  const supersededBy = new Map<string, string>();
  const produced = new Map<string, Call>();
  for (let k = calls.length - 1; k >= 0; k--) {
    const c = calls[k]!;
    if (!c.use || !c.result) continue;
    const { reads, produces } = keysOf(c.use, c.result);
    for (const key of reads) {
      const later = produced.get(key);
      if (later) {
        supersededBy.set(c.tool_use_id, describeLater(later));
        break;
      }
    }
    for (const key of produces) produced.set(key, c);
  }

  const newTexts = new Map<string, string>();
  const newInputs = new Map<string, Record<string, unknown>>();
  const decisions: Decision[] = [];
  let mediaRemoved = 0;

  for (const c of calls) {
    const tool = c.use?.tool ?? 'unknown';
    const zone = unread(c) ? 'recent' : zoneOf(c.resultRow >= 0 ? c.resultRow : c.useRow);
    const media = o.media?.get(c.tool_use_id);
    const mediaCount = media ? media.images + media.documents : 0;
    mediaRemoved += mediaCount;

    let inputTrimmed = false;
    if (c.use && zone !== 'recent') {
      const r = trimInput(c.use.input, o.inputMax);
      if (r.changed) {
        newInputs.set(c.tool_use_id, r.value as Record<string, unknown>);
        inputTrimmed = true;
      }
    }

    const original = c.result?.text ?? c.use?.text;
    if (original === undefined) {
      decisions.push({ tool_use_id: c.tool_use_id, tool, zone, action: 'kept', charsBefore: 0, charsAfter: 0, inputTrimmed, media: mediaCount });
      continue;
    }

    const error = c.result?.isError ?? c.use?.isError === true;
    let text = original;
    let action: Action = 'kept';
    const reason = supersededBy.get(c.tool_use_id);
    if (reason && zone !== 'recent') {
      const note = `${NOTE} result removed to save context, not an error: ${reason}, so this one is obsolete (${original.length} chars)]`;
      if (note.length + 40 < original.length) {
        text = note;
        action = 'superseded';
      }
    }
    if (action === 'kept') {
      // Not yet read: only an outsized result is cut, and never below the base cap.
      const huge = unread(c) ? Math.max(o.huge, DEFAULT_OPTIONS.huge) : o.huge;
      const limits =
        (unread(c) ? undefined : limitsFor(zone, tool, error, o)) ??
        (original.length > huge ? { head: Math.round(huge * 0.7), tail: Math.round(huge * 0.3) } : undefined);
      if (limits) {
        const shorter = cut(original, limits, !READS_FILES.has(tool));
        if (shorter !== original) {
          text = shorter;
          action = 'trimmed';
        }
      }
    }
    if (media && mediaCount > 0) {
      const note = mediaNote(tool, c.use ? pathOf(c.use) : undefined, media);
      if (!text.includes(note)) text = `${text}${text ? '\n' : ''}${note}`;
    }
    if (text !== original) newTexts.set(c.tool_use_id, text);
    decisions.push({
      tool_use_id: c.tool_use_id,
      tool,
      zone,
      action,
      ...(action === 'superseded' && reason ? { reason } : {}),
      charsBefore: original.length,
      charsAfter: text.length,
      inputTrimmed,
      media: mediaCount,
    });
  }

  // Hidden context goes back in front of the row it preceded; old attachments get cut too.
  const extrasAt = new Map<number, Extra[]>();
  for (const x of o.extras ?? []) {
    const list = extrasAt.get(x.before) ?? [];
    list.push(x);
    extrasAt.set(x.before, list);
  }
  const extraRow = (x: Extra): Message => {
    let text = x.text;
    const zone = zoneOf(x.before);
    if (x.kind === 'attachment' && zone !== 'recent') {
      text = cut(text, zone === 'middle' ? o.middle : o.old);
    }
    return { role: 'user', text, toolUses: [] };
  };

  const out: Message[] = [];
  let emptyDropped = 0;
  let extras = 0;
  for (let i = 0; i <= n; i++) {
    for (const x of extrasAt.get(i) ?? []) {
      out.push(extraRow(x));
      extras += 1;
    }
    const m = messages[i];
    if (!m) continue;
    const toolUses: ToolUse[] = m.toolUses.map((use) => {
      const next: ToolUse = {
        tool_use_id: use.tool_use_id,
        tool: use.tool,
        input: newInputs.get(use.tool_use_id) ?? use.input,
      };
      if (use.text !== undefined) next.text = newTexts.get(use.tool_use_id) ?? use.text;
      if (use.isError) next.isError = true;
      return next;
    });
    const toolResults: ToolResult[] = (m.toolResults ?? []).map((r) => ({
      tool_use_id: r.tool_use_id,
      text: newTexts.get(r.tool_use_id) ?? r.text,
      isError: r.isError,
    }));
    if (m.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      emptyDropped += 1;
      continue;
    }
    const next: Message = { role: m.role, text: m.text, toolUses };
    if (toolResults.length > 0) next.toolResults = toolResults;
    out.push(next);
  }

  const grouped = regroup(out);
  const count = (a: Action): number => decisions.filter((d) => d.action === a).length;
  return {
    messages: grouped,
    decisions,
    stats: {
      messagesBefore: n,
      messagesAfter: grouped.length,
      emptyDropped,
      charsBefore,
      charsAfter: grouped.reduce((s, m) => s + messageChars(m), 0),
      calls: calls.length,
      kept: count('kept'),
      trimmed: count('trimmed'),
      superseded: count('superseded'),
      inputsTrimmed: decisions.filter((d) => d.inputTrimmed).length,
      mediaRemoved,
      extras,
      ms: Date.now() - started,
    },
  };
}
