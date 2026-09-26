/**
 * The Claude Code side (function hooks, early access).
 *
 * - `session.compact`: instead of the summary, hand back the pruned conversation
 *   from `../src/prune.ts`. When pruning cannot free enough, or it is not the right
 *   moment, the built-in summary runs as usual (`next(e)`).
 * - `turn.complete`: once the context passes the threshold, ask for a compaction,
 *   so the conversation is pruned early instead of summarized at the limit.
 * - `/lopper`: the latest compactions and what they removed.
 */
import type { Register, SessionMessage } from 'claude-code';

import { readHidden } from '../src/hidden.ts';
import {
  DEFAULT_OPTIONS,
  estimateTokens,
  prune,
  tighter,
  type Media,
  type Extra,
  type Options,
  type Result,
} from '../src/prune.ts';

/** Fixed context when the engine cannot say: system prompt, tools, memory, skill list. */
const FIXED_MAIN = 45_000;
const FIXED_SUBAGENT = 20_000;
/**
 * What Claude Code attaches again right after any compaction (skill list, deferred
 * tools, instructions): measured at 10-20k tokens on 2.1.283.
 */
const REATTACHED = 15_000;
/** A subagent's model is unknown here: assume the smaller window. */
const SUBAGENT_WINDOW = 200_000;
const HISTORY_MAX = 50;

export type Language = 'en' | 'it';

export type Config = {
  /** Past this many tokens of context, lopper prunes on its own (at most 60% of the window). */
  threshold: number;
  /** Where pruning aims to land (at most 60% of the threshold). */
  target: number;
  recentTokens: number;
  /** When false: no automatic pruning, only `/compact` and Claude Code's own limit. */
  auto: boolean;
  language: Language;
};

export function readConfig(options: Readonly<Record<string, unknown>>): Config {
  const number = (key: string, fallback: number): number => {
    const v = options[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    threshold: number('threshold', 300_000),
    target: number('target', 150_000),
    recentTokens: number('recentTokens', DEFAULT_OPTIONS.recentTokens),
    auto: options['auto'] !== false,
    language: options['language'] === 'it' ? 'it' : 'en',
  };
}

/** Threshold and target scaled to the model's window (200k, 1M…). */
export function limits(c: Config, window: number): { threshold: number; target: number } {
  const threshold = Math.min(c.threshold, Math.round(window * 0.6));
  const target = Math.min(c.target, Math.round(threshold * 0.6));
  return { threshold, target };
}

export type Refusal =
  | { why: 'little'; freed: number }
  | { why: 'still-big'; after: number; threshold: number }
  | { why: 'grew-little'; grown: number }
  | { why: 'nothing' };

export type Verdict =
  | { kind: 'pruned'; result: Result; before: number; after: number; pass: 1 | 2 }
  | { kind: 'summary'; refusal: Refusal; before: number; after?: number };

export type Context = {
  /** The context's real size, when the engine knows it (the main conversation). */
  tokens?: number;
  window: number;
  /** Tokens the conversation itself does not account for: prompt, tools, memory. */
  fixed: number;
};

/**
 * Chooses between pruning and the summary. Prunes twice at most (the second pass
 * tighter) and accepts only when that frees enough and leaves room under the
 * threshold; otherwise the next compaction would come right away.
 */
export function decide(
  messages: readonly SessionMessage[],
  c: Config,
  context: Context,
  hidden?: { media?: ReadonlyMap<string, Media>; extras?: readonly Extra[] },
  /** Estimated tokens right after this conversation's previous pruning, if any. */
  previous?: number,
): Verdict {
  const { threshold, target } = limits(c, context.window);
  const options: Options = {
    ...DEFAULT_OPTIONS,
    recentTokens: c.recentTokens,
    ...(hidden?.media ? { media: hidden.media } : {}),
    ...(hidden?.extras ? { extras: hidden.extras } : {}),
  };
  let result = prune(messages, options);
  const before = context.tokens ?? context.fixed + estimateTokens(result.stats.charsBefore);
  // Grown too little since the last pruning: pruning again would bring us straight back.
  if (previous !== undefined && before - previous < Math.max(20_000, threshold * 0.1)) {
    return { kind: 'summary', refusal: { why: 'grew-little', grown: Math.max(0, before - previous) }, before };
  }
  const estimate = (r: Result): number => context.fixed + REATTACHED + estimateTokens(r.stats.charsAfter);
  let after = estimate(result);
  let pass: 1 | 2 = 1;
  if (after > target) {
    const tight = prune(messages, tighter(options));
    if (estimate(tight) < after) {
      result = tight;
      after = estimate(tight);
      pass = 2;
    }
  }
  const s = result.stats;
  if (s.trimmed + s.superseded + s.inputsTrimmed + s.mediaRemoved + s.emptyDropped === 0) {
    return { kind: 'summary', refusal: { why: 'nothing' }, before, after };
  }
  const freed = before - after;
  if (freed < Math.max(15_000, before * 0.15)) {
    return { kind: 'summary', refusal: { why: 'little', freed: Math.max(0, freed) }, before, after };
  }
  if (after > threshold * 0.75) {
    return { kind: 'summary', refusal: { why: 'still-big', after, threshold }, before, after };
  }
  return { kind: 'pruned', result, before, after, pass };
}

function k(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

const TEXT = {
  en: {
    refusal(r: Refusal): string {
      switch (r.why) {
        case 'little':
          return `pruning would free only ~${k(r.freed)} tokens`;
        case 'still-big':
          return `even pruned it would stay at ~${k(r.after)} tokens, too close to the ${k(r.threshold)} threshold`;
        case 'grew-little':
          return `only ~${k(r.grown)} tokens since the last pruning, so pruning again would not last`;
        case 'nothing':
          return 'there is nothing old enough to prune';
      }
    },
    instructions: '/compact with instructions asks for a summary',
    error: (m: string) => `error: ${m}`,
    summary: (why: string) => `built-in summary (${why})`,
    skipped: (why: string) => `not compacting yet (${why})`,
    autoFailed: (m: string) => `automatic compaction did not start (${m})`,
    pruned(v: Extract<Verdict, { kind: 'pruned' }>): string {
      const s = v.result.stats;
      const parts = [
        s.trimmed > 0 ? `${s.trimmed} results trimmed` : '',
        s.superseded > 0 ? `${s.superseded} superseded` : '',
        s.inputsTrimmed > 0 ? `${s.inputsTrimmed} inputs trimmed` : '',
        s.mediaRemoved > 0 ? `${s.mediaRemoved} images removed` : '',
      ].filter(Boolean);
      const percent = Math.round((1 - v.after / v.before) * 100);
      return `${k(v.before)} → ~${k(v.after)} tokens (−${percent}%) in ${s.ms} ms${
        v.pass === 2 ? ', tight pass' : ''
      }; ${parts.join(', ') || 'thinking and images dropped'}; every word kept`;
    },
    toast: (v: Extract<Verdict, { kind: 'pruned' }>) =>
      `${k(v.before)} → ~${k(v.after)} tokens in ${v.result.stats.ms} ms · every word kept`,
    heading: (c: Config) =>
      `threshold ${k(c.threshold)} tokens, target ${k(c.target)}, recent ${k(c.recentTokens)} kept whole; automatic ${c.auto ? 'on' : 'off'}.`,
    none: 'No compaction recorded yet.',
    totals: (n: number, pruned: number) =>
      `${n === 1 ? 'Last compaction' : `Last ${n} compactions`}: ${pruned} pruned, ${n - pruned} left to the built-in summary.`,
    rowPruned: (e: Entry) =>
      `${k(e.before)} → ~${k(e.after ?? 0)}: ${e.trimmed ?? 0} trimmed, ${e.superseded ?? 0} superseded, ${e.media ?? 0} images, ${e.ms ?? 0} ms`,
    rowSummary: (e: Entry) => `built-in summary: ${e.reason ?? ''}`,
    rowSkipped: (e: Entry) => `skipped: ${e.reason ?? ''}`,
  },
  it: {
    refusal(r: Refusal): string {
      switch (r.why) {
        case 'little':
          return `potando si libererebbero solo ~${k(r.freed)} token`;
        case 'still-big':
          return `anche potata resterebbe a ~${k(r.after)} token, troppo vicino alla soglia di ${k(r.threshold)}`;
        case 'grew-little':
          return `solo ~${k(r.grown)} token dall'ultima potatura: potare ancora non durerebbe`;
        case 'nothing':
          return "non c'è niente di abbastanza vecchio da potare";
      }
    },
    instructions: '/compact con istruzioni chiede un riassunto',
    error: (m: string) => `errore: ${m}`,
    summary: (why: string) => `riassunto normale (${why})`,
    skipped: (why: string) => `per ora niente compattazione (${why})`,
    autoFailed: (m: string) => `compattazione automatica non partita (${m})`,
    pruned(v: Extract<Verdict, { kind: 'pruned' }>): string {
      const s = v.result.stats;
      const parts = [
        s.trimmed > 0 ? `${s.trimmed} risultati accorciati` : '',
        s.superseded > 0 ? `${s.superseded} superati` : '',
        s.inputsTrimmed > 0 ? `${s.inputsTrimmed} input accorciati` : '',
        s.mediaRemoved > 0 ? `${s.mediaRemoved} immagini tolte` : '',
      ].filter(Boolean);
      const percent = Math.round((1 - v.after / v.before) * 100);
      return `${k(v.before)} → ~${k(v.after)} token (−${percent}%) in ${s.ms} ms${
        v.pass === 2 ? ', taglio stretto' : ''
      }; ${parts.join(', ') || 'tolti pensiero e immagini'}; testo intatto`;
    },
    toast: (v: Extract<Verdict, { kind: 'pruned' }>) =>
      `${k(v.before)} → ~${k(v.after)} token in ${v.result.stats.ms} ms · testo intatto`,
    heading: (c: Config) =>
      `soglia ${k(c.threshold)} token, obiettivo ${k(c.target)}, recenti intatti ${k(c.recentTokens)}; automatica ${c.auto ? 'sì' : 'no'}.`,
    none: 'Nessuna compattazione registrata finora.',
    totals: (n: number, pruned: number) =>
      `${n === 1 ? 'Ultima compattazione' : `Ultime ${n} compattazioni`}: ${pruned} potate, ${n - pruned} passate al riassunto normale.`,
    rowPruned: (e: Entry) =>
      `${k(e.before)} → ~${k(e.after ?? 0)}: ${e.trimmed ?? 0} accorciati, ${e.superseded ?? 0} superati, ${e.media ?? 0} immagini, ${e.ms ?? 0} ms`,
    rowSummary: (e: Entry) => `riassunto normale: ${e.reason ?? ''}`,
    rowSkipped: (e: Entry) => `rimandata: ${e.reason ?? ''}`,
  },
} as const;

export type Entry = {
  at: string;
  trigger: string;
  kind: 'pruned' | 'summary' | 'skipped';
  reason?: string;
  before: number;
  after?: number;
  pass?: number;
  trimmed?: number;
  superseded?: number;
  inputsTrimmed?: number;
  media?: number;
  extras?: number;
  rows?: string;
  ms?: number;
};

export function report(history: readonly Entry[], c: Config): string {
  const t = TEXT[c.language];
  const lines: string[] = [t.heading(c)];
  if (history.length === 0) {
    lines.push(t.none);
    return lines.join('\n');
  }
  lines.push(t.totals(history.length, history.filter((e) => e.kind === 'pruned').length));
  for (const e of history.slice(-10).reverse()) {
    const when = e.at.slice(0, 16).replace('T', ' ');
    const row = e.kind === 'pruned' ? t.rowPruned(e) : e.kind === 'summary' ? t.rowSummary(e) : t.rowSkipped(e);
    lines.push(`- ${when} (${e.trigger}) ${row}`);
  }
  return lines.join('\n');
}

function entry(trigger: string, v: Verdict, at: string, c: Config, skipped = false): Entry {
  if (v.kind === 'summary') {
    return {
      at,
      trigger,
      kind: skipped ? 'skipped' : 'summary',
      reason: TEXT[c.language].refusal(v.refusal),
      before: v.before,
      ...(v.after !== undefined ? { after: v.after } : {}),
    };
  }
  const s = v.result.stats;
  return {
    at,
    trigger,
    kind: 'pruned',
    before: v.before,
    after: v.after,
    pass: v.pass,
    trimmed: s.trimmed,
    superseded: s.superseded,
    inputsTrimmed: s.inputsTrimmed,
    media: s.mediaRemoved,
    extras: s.extras,
    rows: `${s.messagesBefore}→${s.messagesAfter}`,
    ms: s.ms,
  };
}

/** The fixed part of the context from the engine's own breakdown, if it gives one. */
export function fixedFrom(categories: unknown): number | undefined {
  if (!Array.isArray(categories)) return undefined;
  let total = 0;
  let seen = false;
  for (const c of categories as { name?: unknown; tokens?: unknown; kind?: unknown }[]) {
    if (c.kind !== 'used' || typeof c.tokens !== 'number' || c.name === 'Messages') continue;
    total += c.tokens;
    seen = true;
  }
  return seen ? total : undefined;
}

type Archive = {
  store: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void> };
  clock: { now: () => Promise<number> };
};

/** Adds a compaction to the history `/lopper` shows. */
async function record($: Archive, e: Entry): Promise<void> {
  try {
    const earlier = await $.store.get('history');
    const history = Array.isArray(earlier) ? (earlier as Entry[]) : [];
    history.push(e);
    await $.store.set('history', history.slice(-HISTORY_MAX));
  } catch {
    // The history is a nicety: if it cannot be written, the compaction goes on.
  }
}

/** Local time, `2026-09-26 00:48`, for the history. */
async function now($: Archive): Promise<string> {
  let ms = Date.now();
  try {
    ms = await $.clock.now();
  } catch {
    // keep Date.now()
  }
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export const register: Register = (on, options) => {
  const c = readConfig(options);
  const t = TEXT[c.language];
  /** Per conversation (session, or session + subagent): estimated tokens after the last pruning. */
  const lastAfter = new Map<string, number>();
  /** Per session: no automatic compaction until the context reaches this size again. */
  const deferredUntil = new Map<string, number>();
  let asking = false;

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'lopper',
        description: 'Latest compactions by lopper and what they removed',
      });
    } catch {
      // In -p mode, or without commands: nothing to do.
    }
    return next(e);
  });

  on('command.run', { command: 'lopper' }, async ($) => {
    const history = await $.store.get('history').catch(() => undefined);
    return { text: report(Array.isArray(history) ? (history as Entry[]) : [], c) };
  });

  on('session.end', async ($, e, next) => {
    try {
      const id = await $.session.id();
      for (const key of [...lastAfter.keys()]) if (key.startsWith(`${id}:`)) lastAfter.delete(key);
      deferredUntil.delete(id);
    } catch {
      lastAfter.clear();
      deferredUntil.clear();
    }
    return next(e);
  });

  on('session.compact', async ($, e, next) => {
    // A precompute prepares a summary ahead of time; pruning takes milliseconds
    // and is done on the spot, so there is nothing to precompute.
    if (e.trigger === 'precompute') return { skip: 'lopper: nothing to precompute' };
    const handOver = (why: string) => {
      $.ui.log(t.summary(why));
      return next(e);
    };
    if (e.instructions && e.instructions.trim().length > 0) return handOver(t.instructions);
    try {
      const session = await $.session.id();
      const key = `${session}:${e.agentId ?? ''}`;
      const main = e.agentId === undefined;
      const usage = await $.session.usage(main ? { breakdown: 'summary' } : undefined);
      const context: Context = main
        ? {
            ...(usage.context.tokens ? { tokens: usage.context.tokens } : {}),
            window: usage.context.window,
            fixed: fixedFrom(usage.context.breakdown?.categories) ?? FIXED_MAIN,
          }
        : { window: Math.min(usage.context.window, SUBAGENT_WINDOW), fixed: FIXED_SUBAGENT };
      let hidden: ReturnType<typeof readHidden> | undefined;
      try {
        hidden = readHidden(
          e.messages,
          await $.session.messages(main ? { as: 'api' } : { agentId: e.agentId, as: 'api' }),
        );
      } catch {
        hidden = undefined;
      }
      const verdict = decide(e.messages, c, context, hidden, lastAfter.get(key));
      const at = await now($);
      if (verdict.kind === 'summary') {
        lastAfter.delete(key);
        const why = t.refusal(verdict.refusal);
        // We asked for this compaction ourselves: better to wait than to summarize early.
        if (e.trigger === 'plugin') {
          const { threshold } = limits(c, context.window);
          deferredUntil.set(session, verdict.before + Math.max(50_000, threshold * 0.1));
          await record($, entry(e.trigger, verdict, at, c, true));
          $.ui.log(t.skipped(why));
          return { skip: `lopper: ${why}` };
        }
        await record($, entry(e.trigger, verdict, at, c));
        return handOver(why);
      }
      lastAfter.set(key, verdict.after);
      deferredUntil.delete(session);
      await record($, entry(main ? e.trigger : `${e.trigger}, subagent`, verdict, at, c));
      $.ui.log(t.pruned(verdict));
      if (main) $.ui.toast(t.toast(verdict), { timeoutMs: 12_000 });
      return {
        messages: verdict.result.messages,
        tokensBefore: verdict.before,
        tokensAfter: verdict.after,
      };
    } catch (error) {
      return handOver(t.error(error instanceof Error ? error.message : String(error)));
    }
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined || !c.auto || asking || e.reason !== 'answer') return result;
    asking = true;
    try {
      const { context } = await $.session.usage();
      const { threshold } = limits(c, context.window);
      const tokens = context.tokens ?? 0;
      const session = await $.session.id();
      if (tokens < threshold || tokens < (deferredUntil.get(session) ?? 0)) return result;
      // The turn is closed here (next has returned), so the engine takes the request.
      await $.session.compact();
    } catch (error) {
      $.ui.log(t.autoFailed(error instanceof Error ? error.message : String(error)));
    } finally {
      asking = false;
    }
    return result;
  });
};
