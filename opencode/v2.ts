/**
 * lopper for opencode 2: the context is pruned, never summarized.
 *
 * opencode 2 hands a plugin the messages of each model call through the session
 * `context` hook; changing them changes only that call, never the stored session.
 * Past the threshold lopper decides a cut over everything so far — old tool output
 * to head + tail, results a later call made obsolete to a note, long inputs of old
 * calls shortened, reasoning and media of finished turns dropped — and sends that
 * same cut with every later call, so the provider's prompt cache holds until the
 * next one. Every word the user and the model wrote stays.
 */
import { DEFAULT_OPTIONS, prune, tighter, type Media, type Message as Row, type Options, type ToolProfile } from '../plugin/src/prune.ts';
import { IMAGE_TOKENS, limits, type Config, type CutSpec, type Language, type Store } from './lopper.ts';

// --- opencode 2's shapes, as far as lopper reads them ----------------------------------

export interface Part {
  type: string;
  [key: string]: unknown;
}

/** A message of a model call: `user`, `assistant`, `tool` (results) or `system` (inline notes). */
export interface Msg {
  id?: string;
  role: string;
  content: Part[];
  metadata?: Record<string, unknown>;
}

interface Result {
  type: string;
  value: unknown;
}

export const OPENCODE_V2: ToolProfile = {
  repeatable: new Set(['read', 'grep', 'glob', 'list', 'webfetch', 'websearch', 'codesearch']),
  needsPath: new Set(['grep', 'glob', 'list']),
  readsFiles: new Set(['read']),
  agents: new Set(['subagent', 'task']),
  keepWhole: new Set(['skill']),
  read: 'read',
  write: 'write',
  // opencode 2 names the file `path`; sessions carried over from opencode 1 still say `filePath`.
  pathKeys: ['path', 'filePath'],
  rangeKeys: ['offset', 'limit'],
  isStub: () => false,
  isPartial: (text) =>
    /\[Output truncated\. Continue reading with offset: \d+\]|full output saved to |Use offset=\d+ to continue\.|Use 'offset' parameter to read beyond|Full output saved to:/.test(
      text,
    ),
};

const isMediaMime = (mime: unknown): boolean =>
  typeof mime === 'string' && (mime.startsWith('image/') || mime === 'application/pdf');

const mimeOfMedia = (p: Part): string => {
  const media = p['media'] as { source?: { mediaType?: unknown } } | undefined;
  return String(media?.source?.mediaType ?? p['mime'] ?? '');
};

/** What the model reads of a tool result. */
export function resultText(r: Result | undefined): string {
  if (!r) return '';
  if (r.type === 'content' && Array.isArray(r.value)) {
    return (r.value as Part[])
      .filter((x) => x.type === 'text')
      .map((x) => String(x['text'] ?? ''))
      .join('\n');
  }
  if (typeof r.value === 'string') return r.value;
  try {
    return JSON.stringify(r.value) ?? '';
  } catch {
    return String(r.value);
  }
}

function resultMedia(r: Result | undefined): Media | undefined {
  if (!r || r.type !== 'content' || !Array.isArray(r.value)) return undefined;
  const files = (r.value as Part[]).filter((x) => x.type === 'file' && isMediaMime(x['mime']));
  if (files.length === 0) return undefined;
  const images = files.filter((x) => String(x['mime']).startsWith('image/')).length;
  return { images, documents: files.length - images };
}

// --- positions ----------------------------------------------------------------------------

const lastIndex = (msgs: readonly Msg[], test: (m: Msg) => boolean): number => {
  for (let i = msgs.length - 1; i >= 0; i--) if (test(msgs[i]!)) return i;
  return -1;
};

/**
 * Where a cut ends: the message it names and the results and notes right after it,
 * which carry no id of their own.
 */
export function endOf(msgs: readonly Msg[], boundaryId: string): number {
  let end = msgs.findIndex((m) => m.id === boundaryId);
  if (end < 0) return -1;
  while (end + 1 < msgs.length && msgs[end + 1]!.id === undefined) end++;
  return end;
}

// --- the cut ------------------------------------------------------------------------------

export interface Cut {
  spec: CutSpec;
  outputs: Map<string, string>;
  inputs: Map<string, Record<string, unknown>>;
  media: Set<string>;
  stats: { trimmed: number; superseded: number; inputs: number; reasoning: number; media: number; ms: number };
}

export function optionsFor(spec: Pick<CutSpec, 'pass' | 'recentTokens' | 'charsPerToken'>): Options {
  const base: Options = {
    ...DEFAULT_OPTIONS,
    recentTokens: spec.recentTokens,
    charsPerToken: spec.charsPerToken,
    profile: OPENCODE_V2,
  };
  return spec.pass === 2 ? tighter(base) : base;
}

/**
 * The messages as lopper rows: a response with its calls, then one row with the
 * results of every call. Inline system notes are left out, so the rows of the past
 * never change between calls.
 */
export function toRows(msgs: readonly Msg[], end: number, lastUser: number): { rows: Row[]; media: Map<string, Media> } {
  const rows: Row[] = [];
  const media = new Map<string, Media>();
  for (let i = 0; i <= end && i < msgs.length; i++) {
    const m = msgs[i]!;
    const finished = i < lastUser;
    if (m.role === 'user') {
      const text = m.content
        .filter((p) => p.type === 'text')
        .map((p) => String(p['text'] ?? ''))
        .join('\n\n');
      rows.push({ role: 'user', text, toolUses: [] });
    } else if (m.role === 'assistant') {
      const texts: string[] = [];
      const row: Row = { role: 'assistant', text: '', toolUses: [] };
      for (const p of m.content) {
        if (p.type === 'text') texts.push(String(p['text'] ?? ''));
        // Reasoning goes with the cut in finished turns; in the turn under way it is sent, so it counts.
        if (p.type === 'reasoning' && !finished) texts.push(String(p['text'] ?? ''));
        if (p.type === 'tool-call') {
          const input = p['input'] && typeof p['input'] === 'object' ? (p['input'] as Record<string, unknown>) : {};
          row.toolUses.push({ tool_use_id: String(p['id']), tool: String(p['name'] ?? ''), input });
        }
      }
      row.text = texts.join('\n\n');
      rows.push(row);
    } else if (m.role === 'tool') {
      const prev = rows[rows.length - 1];
      const results: Row =
        prev && prev.role === 'user' && prev.toolResults && prev.text === '' ? prev : { role: 'user', text: '', toolUses: [], toolResults: [] };
      if (results !== prev) rows.push(results);
      for (const p of m.content) {
        if (p.type !== 'tool-result') continue;
        const id = String(p['id']);
        const r = p['result'] as Result | undefined;
        results.toolResults!.push({ tool_use_id: id, text: resultText(r), isError: r?.type === 'error' });
        const files = finished ? resultMedia(r) : undefined;
        if (files) media.set(id, files);
      }
    }
  }
  return { rows, media };
}

export function computeCut(msgs: readonly Msg[], spec: Omit<CutSpec, 'after'> & { after?: number }): Cut | undefined {
  const end = endOf(msgs, spec.boundaryId);
  const lastUser = msgs.findIndex((m) => m.id === spec.lastUserId);
  if (end < 0 || lastUser < 0) return undefined;
  const started = Date.now();
  const { rows, media } = toRows(msgs, end, lastUser);
  const result = prune(rows, { ...optionsFor(spec), media });
  // prune hands back the very same input object, and the same text, for what it kept.
  const inputWas = new Map(rows.flatMap((r) => r.toolUses.map((u) => [u.tool_use_id, u.input] as const)));
  const textWas = new Map(rows.flatMap((r) => (r.toolResults ?? []).map((t) => [t.tool_use_id, t.text] as const)));
  const outputs = new Map<string, string>();
  const inputs = new Map<string, Record<string, unknown>>();
  for (const r of result.messages) {
    for (const u of r.toolUses) if (u.input !== inputWas.get(u.tool_use_id)) inputs.set(u.tool_use_id, u.input);
    for (const t of r.toolResults ?? []) if (t.text !== textWas.get(t.tool_use_id)) outputs.set(t.tool_use_id, t.text);
  }
  let reasoning = 0;
  for (let i = 0; i < lastUser; i++) reasoning += msgs[i]!.content.filter((p) => p.type === 'reasoning').length;
  return {
    spec: { after: 0, ...spec },
    outputs,
    inputs,
    media: new Set(media.keys()),
    stats: {
      trimmed: result.stats.trimmed,
      superseded: result.stats.superseded,
      inputs: result.stats.inputsTrimmed,
      reasoning,
      media: result.stats.mediaRemoved,
      ms: Date.now() - started,
    },
  };
}

const mediaNote = (lang: Language, what: string): string =>
  lang === 'it'
    ? `[lopper:⁠ rimosso ${what} per risparmiare contesto; chiedilo di nuovo se ti serve]`
    : `[lopper:⁠ removed ${what} to save context; ask for it again if you need it]`;

function cutResult(r: Result, output: string | undefined, dropMedia: boolean): Result {
  if (r.type === 'content' && Array.isArray(r.value)) {
    const items = r.value as Part[];
    const files = dropMedia ? [] : items.filter((x) => x.type === 'file');
    const text = output ?? resultText(r);
    return { ...r, value: [{ type: 'text', text }, ...files] };
  }
  if (output === undefined) return r;
  return { type: r.type === 'error' ? 'error' : 'text', value: output };
}

/** A copy of an opencode message with new parts, of the same class as the original. */
function withContent(m: Msg, content: Part[]): Msg {
  const copy = Object.create(Object.getPrototypeOf(m) as object) as Msg;
  Object.assign(copy, m);
  copy.content = content;
  return copy;
}

/** The cut applied to every message it covers. The array is changed, the messages are copied. */
export function applyCut(msgs: Msg[], cut: Cut, lang: Language = 'en'): void {
  const lastUser = msgs.findIndex((m) => m.id === cut.spec.lastUserId);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    const finished = lastUser >= 0 && i < lastUser;
    let changed = false;
    const content: Part[] = [];
    for (const p of m.content) {
      if (p.type === 'reasoning' && finished && m.role === 'assistant') {
        changed = true;
        continue;
      }
      if (p.type === 'tool-call') {
        const input = cut.inputs.get(String(p['id']));
        if (input !== undefined) {
          content.push({ ...p, input });
          changed = true;
          continue;
        }
      }
      if (p.type === 'tool-result') {
        const id = String(p['id']);
        const output = cut.outputs.get(id);
        const dropMedia = cut.media.has(id);
        const r = p['result'] as Result | undefined;
        if (r && (output !== undefined || dropMedia)) {
          content.push({ ...p, result: cutResult(r, output, dropMedia) });
          changed = true;
          continue;
        }
      }
      if (p.type === 'media' && m.role === 'user' && finished && isMediaMime(mimeOfMedia(p))) {
        const name = typeof p['filename'] === 'string' ? ` (${p['filename']})` : '';
        const what = lang === 'it' ? `un file allegato prima dall'utente${name}` : `a file the user attached earlier${name}`;
        content.push({ type: 'text', text: mediaNote(lang, what) });
        changed = true;
        continue;
      }
      content.push(p);
    }
    if (changed) msgs[i] = withContent(m, content);
  }
}

/** Characters of the messages a call sends; an image counts as `IMAGE_TOKENS`. */
export function sentChars(msgs: readonly Msg[], charsPerToken: number): number {
  let total = 0;
  for (const m of msgs) {
    for (const p of m.content) {
      if (p.type === 'text' || p.type === 'reasoning') total += String(p['text'] ?? '').length;
      else if (p.type === 'tool-call') total += JSON.stringify(p['input'] ?? {}).length;
      else if (p.type === 'tool-result') {
        const r = p['result'] as Result | undefined;
        total += resultText(r).length;
        const files = resultMedia(r);
        if (files) total += (files.images + files.documents) * IMAGE_TOKENS * charsPerToken;
      } else if (p.type === 'media') total += IMAGE_TOKENS * charsPerToken;
    }
  }
  return total;
}

export type Verdict =
  | { kind: 'cut'; cut: Cut }
  | { kind: 'refused'; why: 'little' | 'nothing'; before: number; after: number };

/**
 * A new cut over everything so far, landing under the target if it can: a second,
 * tighter pass when the first is not enough. Refused when it would free too little —
 * the next call would only meet the threshold again.
 */
export function decide(msgs: Msg[], current: Cut | undefined, c: Config, ctx: number, window?: number): Verdict | undefined {
  const lastUser = lastIndex(msgs, (m) => m.role === 'user' && m.id !== undefined);
  const boundary = lastIndex(msgs, (m) => m.id !== undefined);
  if (lastUser < 0 || boundary < 0) return undefined;
  const { target } = limits(c, window);
  const sent = (cut?: Cut): number => {
    const copy = msgs.slice();
    if (cut) applyCut(copy, cut);
    return sentChars(copy, c.charsPerToken);
  };
  const now = sent(current);
  const base = {
    boundaryId: msgs[boundary]!.id!,
    lastUserId: msgs[lastUser]!.id!,
    recentTokens: c.recentTokens,
    charsPerToken: c.charsPerToken,
    before: ctx,
    at: Date.now(),
  };
  const estimate = (cut: Cut): number => Math.round(ctx - (now - sent(cut)) / c.charsPerToken);
  let cut = computeCut(msgs, { ...base, pass: 1 });
  if (!cut) return undefined;
  let after = estimate(cut);
  if (after > target) {
    const tight = computeCut(msgs, { ...base, pass: 2 });
    if (tight) {
      const a = estimate(tight);
      if (a < after) {
        cut = tight;
        after = a;
      }
    }
  }
  const s = cut.stats;
  if (s.trimmed + s.superseded + s.inputs + s.reasoning + s.media === 0) return { kind: 'refused', why: 'nothing', before: ctx, after };
  if (ctx - after < Math.max(15_000, ctx * 0.15)) return { kind: 'refused', why: 'little', before: ctx, after };
  cut.spec.after = after;
  return { kind: 'cut', cut };
}

// --- the engine -----------------------------------------------------------------------------

interface Session {
  firstId: string;
  cut?: Cut;
  spec?: CutSpec;
  /** Context size when a cut was last refused: no new try until it grows. */
  refusedAt?: number;
}

export interface Call {
  sessionID: string;
  messages: Msg[];
  /** Tokens of the previous call, as the provider reported them; estimated when unknown. */
  context?: number;
  /** Characters sent besides the messages: system instructions and tool definitions. */
  fixedChars?: number;
  window?: number;
  /** A summary call: the current cut is applied, no new one is decided. */
  readOnly?: boolean;
}

const withCut = (msgs: Msg[], cut: Cut | undefined): Msg[] => {
  const copy = msgs.slice();
  if (cut) applyCut(copy, cut);
  return copy;
};

const estimateOf = (call: Call, c: Config): number =>
  Math.round(((call.fixedChars ?? 0) + sentChars(call.messages, c.charsPerToken)) / c.charsPerToken);

export interface Engine {
  transform(call: Call): Verdict | undefined;
  reset(sessionID: string): void;
}

/** The plugin's logic without opencode around it, for the hook and for tests. */
export function engine(c: Config, store: Store): Engine {
  const sessions = new Map<string, Session>();
  return {
    reset(id) {
      sessions.delete(id);
      store.drop(id);
    },
    transform(call) {
      const msgs = call.messages;
      const firstId = msgs.find((m) => m.id !== undefined)?.id;
      if (!firstId) return undefined;
      const id = call.sessionID;
      let s = sessions.get(id) ?? store.load(id);
      if (!s || s.firstId !== firstId) {
        // A new session, or opencode summarized it: what lopper knew no longer applies.
        s = { firstId };
        store.drop(id);
      }
      sessions.set(id, s);
      // After a restart the cut is computed again from what it covered: the same result.
      if (!s.cut && s.spec) {
        s.cut = computeCut(msgs, s.spec);
        if (!s.cut) s.spec = undefined;
        else s.cut.spec.after = s.spec.after;
      }
      // Unknown until opencode reports a step: estimated on what is sent, the current cut applied.
      const ctx = call.context ?? estimateOf({ ...call, messages: withCut(msgs, s.cut) }, c);
      let verdict: Verdict | undefined;
      if (!call.readOnly && c.auto) {
        const { threshold } = limits(c, call.window);
        const grown = Math.max(20_000, threshold * 0.1);
        const due =
          ctx > threshold &&
          (!s.cut || ctx - s.cut.spec.after >= grown) &&
          (s.refusedAt === undefined || ctx - s.refusedAt >= grown);
        if (due) {
          verdict = decide(msgs, s.cut, c, ctx, call.window);
          if (verdict?.kind === 'cut') {
            s.cut = verdict.cut;
            s.spec = verdict.cut.spec;
            s.refusedAt = undefined;
            store.log({ sessionID: id, event: 'cut', host: 'opencode2', ...verdict.cut.spec, ...verdict.cut.stats });
          } else if (verdict?.kind === 'refused') {
            s.refusedAt = ctx;
            store.log({ sessionID: id, event: 'refused', host: 'opencode2', ...verdict });
          }
          store.save(id, s as Parameters<Store['save']>[1]);
        }
      }
      if (s.cut) applyCut(msgs, s.cut, c.language);
      return verdict;
    },
  };
}
