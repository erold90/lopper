/**
 * lopper for opencode: the context is pruned, never summarized.
 *
 * Through `experimental.chat.messages.transform` it changes only the copy of the
 * conversation sent with each request; the stored session stays whole. Once the
 * context passes the threshold, lopper decides a cut over everything so far — old
 * tool output to head + tail, results a later call made obsolete to a note, long
 * inputs of old calls shortened, reasoning and images of finished turns dropped —
 * and sends that same cut with every later request, so the provider's prompt cache
 * holds until the next one. Every word the user and the model wrote stays.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_OPTIONS, prune, tighter, type Media, type Message as Row, type Options, type ToolProfile } from '../plugin/src/prune.ts';

// --- opencode's shapes, as far as lopper reads them -----------------------------------

export interface OcPart {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface OcMessage {
  info: {
    id: string;
    sessionID: string;
    role: 'user' | 'assistant';
    summary?: boolean;
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
    model?: { providerID: string; modelID: string };
    [key: string]: unknown;
  };
  parts: OcPart[];
}

interface ToolState {
  status: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  attachments?: OcPart[];
  [key: string]: unknown;
}

const stateOf = (p: OcPart): ToolState | undefined => (p.type === 'tool' ? (p['state'] as ToolState) : undefined);
const callOf = (p: OcPart): string => String(p['callID'] ?? p.id ?? '');

export const OPENCODE: ToolProfile = {
  repeatable: new Set(['read', 'grep', 'glob', 'list', 'webfetch', 'websearch', 'codesearch']),
  needsPath: new Set(['grep', 'glob', 'list']),
  readsFiles: new Set(['read']),
  agents: new Set(['task']),
  keepWhole: new Set(['skill']),
  read: 'read',
  write: 'write',
  pathKeys: ['filePath'],
  rangeKeys: ['offset', 'limit'],
  isStub: () => false,
  isPartial: (text) =>
    /Use offset=\d+ to continue\.|Use 'offset' parameter to read beyond|Full output saved to:/.test(text),
};

/** Measured on DeepSeek V4.1 Flash through Venice, October 2026: 3.37 characters per token. */
export const CHARS_PER_TOKEN = 3.3;
/** What an image costs a vision model, roughly, whatever its base64 length. */
export const IMAGE_TOKENS = 1_500;

const isMedia = (mime: unknown): boolean =>
  typeof mime === 'string' && (mime.startsWith('image/') || mime === 'application/pdf');

// --- configuration --------------------------------------------------------------------

export type Language = 'en' | 'it';

export interface Config {
  /** Past this many tokens of context, lopper cuts (at most 60% of the model's window). */
  threshold: number;
  /** Where a cut aims to land (at most 60% of the threshold). */
  target: number;
  /** The newest tokens, where tool results stay whole. */
  recentTokens: number;
  auto: boolean;
  language: Language;
  charsPerToken: number;
}

export const DEFAULT_CONFIG: Config = {
  threshold: 160_000,
  target: 90_000,
  recentTokens: 30_000,
  auto: true,
  language: 'en',
  charsPerToken: CHARS_PER_TOKEN,
};

export function readConfig(raw: unknown): Config {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (key: keyof Config): number => {
    const v = o[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : (DEFAULT_CONFIG[key] as number);
  };
  return {
    threshold: num('threshold'),
    target: num('target'),
    recentTokens: num('recentTokens'),
    auto: o['auto'] !== false,
    language: o['language'] === 'it' ? 'it' : 'en',
    charsPerToken: num('charsPerToken'),
  };
}

export function limits(c: Config, window: number | undefined): { threshold: number; target: number } {
  const threshold = window && window > 0 ? Math.min(c.threshold, Math.round(window * 0.6)) : c.threshold;
  return { threshold, target: Math.min(c.target, Math.round(threshold * 0.6)) };
}

// --- the cut ----------------------------------------------------------------------------

/** What is kept between requests: enough to compute the very same cut again. */
export interface CutSpec {
  /** The last message the cut covers; later messages are sent as they are. */
  boundaryId: string;
  /** Reasoning and images go only from the turns before this user message. */
  lastUserId: string;
  pass: 1 | 2;
  recentTokens: number;
  charsPerToken: number;
  before: number;
  after: number;
  at: number;
}

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
    profile: OPENCODE,
  };
  return spec.pass === 2 ? tighter(base) : base;
}

/** The copies lopper sends, mapped back to what opencode stored. */
const ORIGINAL = new WeakMap<OcMessage, OcMessage>();
const original = (m: OcMessage): OcMessage => ORIGINAL.get(m) ?? m;

const lastIndex = (msgs: readonly OcMessage[], test: (m: OcMessage) => boolean): number => {
  for (let i = msgs.length - 1; i >= 0; i--) if (test(msgs[i]!)) return i;
  return -1;
};

/**
 * opencode's messages as lopper rows: a tool call and its result live in one part
 * here, so each assistant message becomes the response and, after it, the results.
 * Synthetic text (reminders opencode adds per request) is left out, so the rows of
 * the past never change between requests.
 */
export function toRows(msgs: readonly OcMessage[], end: number, lastUser: number): { rows: Row[]; media: Map<string, Media> } {
  const rows: Row[] = [];
  const media = new Map<string, Media>();
  for (let i = 0; i <= end && i < msgs.length; i++) {
    const m = original(msgs[i]!);
    const finished = i < lastUser;
    if (m.info.role === 'user') {
      const text = m.parts
        .filter((p) => p.type === 'text' && !p['synthetic'] && !p['ignored'])
        .map((p) => String(p['text'] ?? ''))
        .join('\n\n');
      rows.push({ role: 'user', text, toolUses: [] });
      continue;
    }
    const texts: string[] = [];
    const row: Row = { role: 'assistant', text: '', toolUses: [] };
    const results: Row = { role: 'user', text: '', toolUses: [], toolResults: [] };
    for (const p of m.parts) {
      if (p.type === 'text') texts.push(String(p['text'] ?? ''));
      // Reasoning goes with the cut in finished turns; in the turn under way it is sent, so it counts.
      if (p.type === 'reasoning' && !finished) texts.push(String(p['text'] ?? ''));
      const st = stateOf(p);
      if (!st || (st.status !== 'completed' && st.status !== 'error')) continue;
      const id = callOf(p);
      row.toolUses.push({ tool_use_id: id, tool: String(p['tool'] ?? ''), input: st.input ?? {} });
      const error = st.status === 'error';
      results.toolResults!.push({ tool_use_id: id, text: String((error ? st.error : st.output) ?? ''), isError: error });
      if (finished && !error) {
        const files = (st.attachments ?? []).filter((a) => isMedia(a['mime']));
        if (files.length > 0) {
          const images = files.filter((a) => String(a['mime']).startsWith('image/')).length;
          media.set(id, { images, documents: files.length - images });
        }
      }
    }
    row.text = texts.join('\n\n');
    rows.push(row);
    if (results.toolResults!.length > 0) rows.push(results);
  }
  return { rows, media };
}

export function computeCut(msgs: readonly OcMessage[], spec: Omit<CutSpec, 'after'> & { after?: number }): Cut | undefined {
  const end = msgs.findIndex((m) => m.info.id === spec.boundaryId);
  const lastUser = msgs.findIndex((m) => m.info.id === spec.lastUserId);
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
  for (let i = 0; i < lastUser; i++) reasoning += original(msgs[i]!).parts.filter((p) => p.type === 'reasoning').length;
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

/** The messages as sent: the cut applied to every message it covers, copies only. */
export function applyCut(msgs: OcMessage[], cut: Cut): void {
  const end = msgs.findIndex((m) => m.info.id === cut.spec.boundaryId);
  const lastUser = msgs.findIndex((m) => m.info.id === cut.spec.lastUserId);
  const upTo = end < 0 ? msgs.length - 1 : end;
  for (let i = 0; i <= upTo; i++) {
    const m = original(msgs[i]!);
    const finished = lastUser >= 0 && i < lastUser;
    let changed = false;
    const parts: OcPart[] = [];
    for (const p of m.parts) {
      if (p.type === 'reasoning' && finished) {
        changed = true;
        continue;
      }
      const st = stateOf(p);
      if (st && (st.status === 'completed' || st.status === 'error')) {
        const id = callOf(p);
        const output = cut.outputs.get(id);
        const input = cut.inputs.get(id);
        const media = cut.media.has(id);
        if (output !== undefined || input !== undefined || media) {
          const state: ToolState = { ...st };
          if (input !== undefined) state.input = input;
          if (output !== undefined) {
            if (state.status === 'completed') state.output = output;
            else state.error = output;
          }
          if (media) state.attachments = (st.attachments ?? []).filter((a) => !isMedia(a['mime']));
          parts.push({ ...p, state });
          changed = true;
          continue;
        }
      }
      if (p.type === 'file' && m.info.role === 'user' && finished && isMedia(p['mime'])) {
        const name = typeof p['filename'] === 'string' ? ` (${p['filename']})` : '';
        parts.push({
          id: p.id,
          sessionID: p['sessionID'],
          messageID: p['messageID'],
          type: 'text',
          synthetic: true,
          text: `[lopper:⁠ removed a file the user attached earlier${name} to save context; ask for it again if you need it]`,
        });
        changed = true;
        continue;
      }
      parts.push(p);
    }
    if (changed) {
      const copy: OcMessage = { info: m.info, parts };
      ORIGINAL.set(copy, m);
      msgs[i] = copy;
    }
  }
}

/** Characters of what a request sends; an image counts as `IMAGE_TOKENS`. */
export function sentChars(msgs: readonly OcMessage[], charsPerToken: number): number {
  let total = 0;
  for (const m of msgs) {
    for (const p of m.parts) {
      if (p.type === 'text' || p.type === 'reasoning') total += String(p['text'] ?? '').length;
      if (p.type === 'file' && isMedia(p['mime'])) total += IMAGE_TOKENS * charsPerToken;
      const st = stateOf(p);
      if (!st) continue;
      total += JSON.stringify(st.input ?? {}).length;
      total += String((st.status === 'error' ? st.error : st.output) ?? '').length;
      total += (st.attachments ?? []).filter((a) => isMedia(a['mime'])).length * IMAGE_TOKENS * charsPerToken;
    }
  }
  return total;
}

/** The real size of the last request, from what the provider reported. */
export function contextTokens(msgs: readonly OcMessage[]): number | undefined {
  const i = lastIndex(msgs, (m) => m.info.role === 'assistant' && !m.info.summary && (m.info.tokens?.input ?? 0) > 0);
  if (i < 0) return undefined;
  const t = msgs[i]!.info.tokens!;
  return (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) + (t.output ?? 0);
}

export type Verdict =
  | { kind: 'cut'; cut: Cut }
  | { kind: 'refused'; why: 'little' | 'nothing'; before: number; after: number };

/**
 * A new cut over everything so far, landing under the target if it can: a second,
 * tighter pass when the first is not enough. Refused when it would free too little —
 * the next request would only meet the threshold again.
 */
export function decide(msgs: OcMessage[], current: Cut | undefined, c: Config, ctx: number, window?: number): Verdict | undefined {
  const lastUser = lastIndex(msgs, (m) => m.info.role === 'user');
  if (lastUser < 0) return undefined;
  const { target } = limits(c, window);
  const sent = (cut?: Cut): number => {
    const copy = msgs.map((m) => m);
    if (cut) applyCut(copy, cut);
    return sentChars(copy, c.charsPerToken);
  };
  const now = sent(current);
  const base = {
    boundaryId: msgs[msgs.length - 1]!.info.id,
    lastUserId: msgs[lastUser]!.info.id,
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

// --- the plugin -------------------------------------------------------------------------

interface Session {
  firstId: string;
  cut?: Cut;
  spec?: CutSpec;
  /** Context size when a cut was last refused: no new try until it grows. */
  refusedAt?: number;
}

const k = (n: number): string => `${Math.round(n / 1000)}k`;

export function cutMessage(cut: Cut, lang: Language): string {
  const { before, after } = cut.spec;
  const s = cut.stats;
  return lang === 'it'
    ? `contesto ${k(before)} → ~${k(after)} token, nessun riassunto · ${s.trimmed} risultati accorciati, ${s.superseded} superati, ${s.reasoning} ragionamenti tolti`
    : `context ${k(before)} → ~${k(after)} tokens, no summary · ${s.trimmed} results trimmed, ${s.superseded} superseded, ${s.reasoning} reasoning blocks dropped`;
}

export interface Store {
  load(sessionID: string): Session | undefined;
  save(sessionID: string, s: Session): void;
  drop(sessionID: string): void;
  log(entry: Record<string, unknown>): void;
}

export function fileStore(dir: string): Store {
  const path = (id: string) => join(dir, 'state', `${id.replace(/[^\w-]/g, '_')}.json`);
  return {
    load(id) {
      try {
        const raw = JSON.parse(readFileSync(path(id), 'utf8')) as { firstId: string; spec?: CutSpec; refusedAt?: number };
        return { firstId: raw.firstId, spec: raw.spec, refusedAt: raw.refusedAt };
      } catch {
        return undefined;
      }
    },
    save(id, s) {
      try {
        mkdirSync(join(dir, 'state'), { recursive: true });
        writeFileSync(path(id), JSON.stringify({ firstId: s.firstId, spec: s.cut?.spec ?? s.spec, refusedAt: s.refusedAt }));
      } catch {}
    },
    drop(id) {
      try {
        rmSync(path(id), { force: true });
      } catch {}
    },
    log(entry) {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'log.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
      } catch {}
    },
  };
}

export interface Engine {
  transform(msgs: OcMessage[], opts?: { readOnly?: boolean; window?: number }): Verdict | undefined;
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
    transform(msgs, opts = {}) {
      const first = msgs[0];
      if (!first) return undefined;
      const id = first.info.sessionID;
      let s = sessions.get(id) ?? store.load(id);
      if (!s || s.firstId !== first.info.id) {
        // A new session, or opencode summarized it: what lopper knew no longer applies.
        s = { firstId: first.info.id };
        store.drop(id);
      }
      sessions.set(id, s);
      // After a restart the cut is computed again from what it covered: the same result.
      if (!s.cut && s.spec) {
        s.cut = computeCut(msgs, s.spec);
        if (!s.cut) s.spec = undefined;
        else s.cut.spec.after = s.spec.after;
      }
      const ctx = contextTokens(msgs);
      let verdict: Verdict | undefined;
      if (!opts.readOnly && c.auto && ctx !== undefined) {
        const { threshold } = limits(c, opts.window);
        const grown = Math.max(20_000, threshold * 0.1);
        const due =
          ctx > threshold &&
          (!s.cut || ctx - s.cut.spec.after >= grown) &&
          (s.refusedAt === undefined || ctx - s.refusedAt >= grown);
        if (due) {
          verdict = decide(msgs, s.cut, c, ctx, opts.window);
          if (verdict?.kind === 'cut') {
            s.cut = verdict.cut;
            s.spec = verdict.cut.spec;
            s.refusedAt = undefined;
            store.log({ sessionID: id, event: 'cut', ...verdict.cut.spec, ...verdict.cut.stats });
          } else if (verdict?.kind === 'refused') {
            s.refusedAt = ctx;
            store.log({ sessionID: id, event: 'refused', ...verdict });
          }
          store.save(id, s);
        }
      }
      if (s.cut) applyCut(msgs, s.cut);
      return verdict;
    },
  };
}

interface PluginInput {
  client?: {
    tui?: { showToast?: (o: { body: { title?: string; message: string; variant: string; duration?: number } }) => Promise<unknown> };
  };
}

const dataDir = (): string =>
  join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'opencode', 'lopper');

/** `~/.config/opencode/lopper.json`, or the file `LOPPER_CONFIG` names. */
function configFile(): unknown {
  const dir = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  try {
    return JSON.parse(readFileSync(process.env['LOPPER_CONFIG'] || join(dir, 'opencode', 'lopper.json'), 'utf8'));
  } catch {
    return {};
  }
}

export const LopperPlugin = async (input: PluginInput) => {
  const c = readConfig(configFile());
  const e = engine(c, fileStore(dataDir()));
  const windows = new Map<string, number>();
  const compacting = new Set<string>();
  return {
    'chat.params': async (i: { sessionID: string; model?: { limit?: { context?: number } } }) => {
      const w = i.model?.limit?.context;
      if (w) windows.set(i.sessionID, w);
    },
    'experimental.session.compacting': async (i: { sessionID: string }) => {
      compacting.add(i.sessionID);
    },
    'experimental.chat.messages.transform': async (_i: unknown, output: { messages: OcMessage[] }) => {
      try {
        const id = output.messages[0]?.info.sessionID;
        if (!id) return;
        // The copy opencode summarizes: same cut, and no new one decided there.
        const readOnly = compacting.delete(id);
        const verdict = e.transform(output.messages, { readOnly, window: windows.get(id) });
        if (verdict?.kind === 'cut') {
          await input.client?.tui
            ?.showToast?.({ body: { title: 'lopper', message: cutMessage(verdict.cut, c.language), variant: 'info', duration: 6000 } })
            .catch(() => undefined);
        }
      } catch {
        // Never block a request: on any trouble the conversation goes as opencode built it.
      }
    },
    event: async ({ event }: { event: { type: string; properties?: { sessionID?: string; info?: { id?: string } } } }) => {
      const id = event.properties?.sessionID ?? event.properties?.info?.id;
      if (!id) return;
      if (event.type === 'session.compacted' || event.type === 'session.deleted') e.reset(id);
    },
  };
};
