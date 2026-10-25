/**
 * Replays a real opencode session through lopper, request by request.
 *
 *   npx tsx scripts/replay-opencode.ts <session.json> [threshold target recentTokens]
 *
 * <session.json> is `opencode export <id>`. For every request the model got, the
 * messages before it go through the plugin as opencode would hand them over; the
 * context it would have sent is measured, the cache misses that really happened are
 * replayed on it, and every request between two cuts must send the same prefix
 * (what keeps the provider's cache valid). Prices: DeepSeek V4.1 Flash on Venice.
 */
import { readFileSync } from 'node:fs';

import { engine, readConfig, sentChars, type OcMessage, type Store } from '../opencode/lopper.ts';

const PRICE = { input: 0.33, cacheRead: 0.00825, output: 1.32 }; // $ per million tokens
/** What stays cached even when the rest misses: the system prompt and tools. */
const SYSTEM_CACHED = 17_000;

const [file, ...nums] = process.argv.slice(2);
if (!file) {
  console.error('usage: tsx scripts/replay-opencode.ts <session.json> [threshold target recentTokens]');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(file, 'utf8')) as { messages?: OcMessage[] } | OcMessage[];
const all: OcMessage[] = (Array.isArray(raw) ? raw : raw.messages ?? []).map((m) => ({
  info: { ...m.info },
  parts: m.parts.map((p) => {
    const st = p['state'] as { time?: { compacted?: number } } | undefined;
    if (!st?.time?.compacted) return p;
    // As if opencode's own pruning had never run.
    const { compacted: _, ...time } = st.time;
    return { ...p, state: { ...st, time } };
  }),
}));

const [threshold, target, recentTokens] = nums.map(Number);
const config = readConfig({ threshold, target, recentTokens });
const silent: Store = { load: () => undefined, save: () => {}, drop: () => {}, log: () => {} };
const lopper = engine(config, silent);
const cpt = config.charsPerToken;
const tok = (n: number) => Math.round(n).toLocaleString('en');

let fixed: number | undefined;
let prevSent: number | undefined;
let prefix: { ids: string[]; json: string } | undefined;
let unstable = 0;
let cuts = 0;
let peakReal = 0;
let peakLopper = 0;
const cost = { real: 0, lopper: 0 };

for (let j = 0; j < all.length; j++) {
  const m = all[j]!;
  if (m.info.role !== 'assistant' || m.info.summary) continue;
  const t = m.info.tokens ?? {};
  const realCtx = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
  if (realCtx === 0) continue;
  const out = (t.output ?? 0) + (t.reasoning ?? 0);
  const before = all.slice(0, j).map((x) => ({ info: { ...x.info }, parts: x.parts }));
  fixed ??= realCtx - sentChars(before, cpt) / cpt;
  // The size the previous request had under lopper, as the provider would have reported it.
  const lastAssistant = [...before].reverse().find((x) => x.info.role === 'assistant');
  if (lastAssistant && prevSent !== undefined) lastAssistant.info.tokens = { input: prevSent, output: 0, cache: { read: 0, write: 0 } };

  const verdict = lopper.transform(before);
  const sent = fixed + sentChars(before, cpt) / cpt;

  // Between two cuts, the messages a cut covers must go out byte for byte the same (their parts are what the model gets).
  const cut = verdict?.kind === 'cut';
  if (cut) {
    cuts += 1;
    console.log(`  cut at request ${j}: ${tok(verdict.cut.spec.before)} → ~${tok(verdict.cut.spec.after)} (pass ${verdict.cut.spec.pass}, ${verdict.cut.stats.ms} ms; sent ${tok(sent)})`);
  }
  if (prefix && !cut) {
    const json = JSON.stringify(before.filter((x) => prefix!.ids.includes(x.info.id)).map((x) => x.parts));
    if (json !== prefix.json) unstable += 1;
  }
  if (cut || prefix) {
    const ids = prefix && !cut ? prefix.ids : before.map((x) => x.info.id);
    prefix = { ids, json: JSON.stringify(before.filter((x) => ids.includes(x.info.id)).map((x) => x.parts)) };
  }

  const realUncached = t.input ?? 0;
  const missed = realUncached > 15_000 && realUncached > (t.cache?.read ?? 0);
  cost.real += (realUncached * PRICE.input + (realCtx - realUncached) * PRICE.cacheRead + out * PRICE.output) / 1e6;
  const uncached = missed || cut ? Math.max(0, sent - SYSTEM_CACHED) : Math.min(realUncached, sent);
  cost.lopper += (uncached * PRICE.input + (sent - uncached) * PRICE.cacheRead + out * PRICE.output) / 1e6;
  peakReal = Math.max(peakReal, realCtx);
  peakLopper = Math.max(peakLopper, sent);
  prevSent = sent + out;
}

console.log(
  `threshold ${tok(config.threshold)} · target ${tok(config.target)} · recent ${tok(config.recentTokens)}\n` +
    `  cuts ${cuts} · requests whose prefix changed between cuts: ${unstable}\n` +
    `  peak context: real ${tok(peakReal)} → lopper ${tok(peakLopper)}\n` +
    `  cost: real $${cost.real.toFixed(3)} → lopper $${cost.lopper.toFixed(3)} (same cache misses replayed)`,
);
