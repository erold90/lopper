/**
 * Replays lopper on real Claude Code transcripts, offline.
 *
 *   npx tsx scripts/replay.ts ~/.claude/projects/<project>/<session>.jsonl [more…]
 *
 * Rebuilds the conversation the way a `session.compact` hook sees it (from the
 * latest compaction point on, one row per block), prunes it and prints numbers
 * only: no message content.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { decide, readConfig } from '../plugin/hooks/lopper.ts';
import { estimateTokens, prune, type Media, type Message } from '../plugin/src/prune.ts';

type Block = Record<string, unknown> & { type?: string };

function resultOf(content: unknown): { text: string; media: Media } {
  const media = { images: 0, documents: 0 };
  if (typeof content === 'string') return { text: content, media };
  if (!Array.isArray(content)) return { text: '', media };
  const parts: string[] = [];
  for (const b of content as Block[]) {
    if (b.type === 'text' && typeof b['text'] === 'string') parts.push(b['text']);
    if (b.type === 'image') media.images += 1;
    if (b.type === 'document') media.documents += 1;
  }
  return { text: parts.join('\n'), media };
}

export function readTranscript(path: string): {
  messages: Message[];
  media: Map<string, Media>;
  lastContext?: number;
} {
  const lines = readFileSync(path, 'utf8').split('\n');
  let start = 0;
  lines.forEach((l, i) => {
    if (l.includes('"subtype":"compact_boundary"')) start = i;
  });
  const messages: Message[] = [];
  const media = new Map<string, Media>();
  const uses = new Map<string, Message>();
  let lastContext: number | undefined;
  for (const line of lines.slice(start)) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d['type'] !== 'user' && d['type'] !== 'assistant') continue;
    const message = d['message'] as { role?: string; content?: unknown; usage?: Record<string, number> } | undefined;
    if (!message) continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if (role === 'assistant' && message.usage) {
      const u = message.usage;
      lastContext = (u['input_tokens'] ?? 0) + (u['cache_read_input_tokens'] ?? 0) + (u['cache_creation_input_tokens'] ?? 0);
    }
    if (typeof message.content === 'string') {
      messages.push({ role, text: message.content, toolUses: [] });
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const b of message.content as Block[]) {
      if (b.type === 'text') messages.push({ role, text: String(b['text'] ?? ''), toolUses: [] });
      else if (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'image') {
        messages.push({ role, text: '', toolUses: [] });
      } else if (b.type === 'tool_use') {
        const m: Message = {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: String(b['id']), tool: String(b['name']), input: (b['input'] ?? {}) as Record<string, unknown> }],
        };
        uses.set(String(b['id']), m);
        messages.push(m);
      } else if (b.type === 'tool_result') {
        const id = String(b['tool_use_id']);
        const { text, media: found } = resultOf(b['content']);
        if (found.images + found.documents > 0) media.set(id, found);
        const isError = b['is_error'] === true;
        messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError }] });
        const use = uses.get(id)?.toolUses[0];
        if (use) {
          use.text = text;
          if (isError) use.isError = true;
        }
      }
    }
  }
  return { messages, media, lastContext };
}

const config = readConfig({});
for (const path of process.argv.slice(2)) {
  const { messages, media, lastContext } = readTranscript(path);
  const context = { ...(lastContext ? { tokens: lastContext } : {}), window: 1_000_000, fixed: 45_000 };
  const started = performance.now();
  const verdict = decide(messages, config, context, { media });
  const ms = Math.round(performance.now() - started);
  const first = prune(messages, { media });
  const perTool = new Map<string, { before: number; after: number }>();
  for (const d of first.decisions) {
    const t = perTool.get(d.tool) ?? { before: 0, after: 0 };
    t.before += d.charsBefore;
    t.after += d.charsAfter;
    perTool.set(d.tool, t);
  }
  const s = first.stats;
  console.log(
    JSON.stringify({
      session: basename(path).slice(0, 8),
      rows: messages.length,
      realContext: lastContext,
      visibleTokens: estimateTokens(s.charsBefore),
      media: s.mediaRemoved,
      firstPass: {
        chars: `${Math.round(s.charsBefore / 1000)}k→${Math.round(s.charsAfter / 1000)}k`,
        trimmed: s.trimmed,
        superseded: s.superseded,
        inputs: s.inputsTrimmed,
        empty: s.emptyDropped,
      },
      verdict:
        verdict.kind === 'pruned'
          ? `pruned ${Math.round(verdict.before / 1000)}k → ~${Math.round(verdict.after / 1000)}k (pass ${verdict.pass})`
          : `summary: ${verdict.refusal.why}`,
      decideMs: ms,
      topTools: [...perTool.entries()]
        .sort((a, b) => b[1].before - a[1].before)
        .slice(0, 5)
        .map(([t, v]) => `${t} ${Math.round(v.before / 1000)}k→${Math.round(v.after / 1000)}k`),
    }),
  );
}
