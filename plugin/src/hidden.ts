/**
 * What the transcript rows do not show but the model reads.
 *
 * Claude Code hands a compaction hook one row per visible block. Some context
 * rides along outside the rows: a skill's instructions, a file attached with @,
 * an image pasted into a prompt. The engine keeps them attached to a row's
 * `handle`, so a rebuilt row would drop them silently. The Messages API form of
 * the conversation (`$.session.messages({ as: "api" })`) still has them: this
 * module lines it up with the rows and says what to put back, and where.
 *
 * Reminders the engine adds again by itself after a compaction (environment,
 * tool lists, dates, token counts) are left out on purpose.
 */
import type { Extra, Media, Message } from './prune.ts';

export interface ApiBlock {
  type: string;
  [field: string]: unknown;
}

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: ApiBlock[];
}

export interface Hidden {
  media: Map<string, Media>;
  extras: Extra[];
}

/** How far ahead a text block may find its row (thinking-only rows sit in between). */
const LOOKAHEAD = 64;

const ATTACHMENT = /^<system-reminder>\s*(Called the Read tool with the following input|Result of calling the Read tool)/;

function countMedia(blocks: unknown): Media {
  const media = { images: 0, documents: 0 };
  if (!Array.isArray(blocks)) return media;
  for (const b of blocks as ApiBlock[]) {
    if (b.type === 'image') media.images += 1;
    else if (b.type === 'document') media.documents += 1;
  }
  return media;
}

function hiddenKind(text: string): Extra['kind'] | undefined {
  if (ATTACHMENT.test(text)) return 'attachment';
  if (text.startsWith('<system-reminder>')) return undefined;
  return 'instructions';
}

export function readHidden(rows: readonly Message[], api: unknown): Hidden {
  const hidden: Hidden = { media: new Map(), extras: [] };
  if (!Array.isArray(api)) return hidden;

  const useRow = new Map<string, number>();
  const resultRow = new Map<string, number>();
  rows.forEach((m, i) => {
    for (const u of m.toolUses) useRow.set(u.tool_use_id, i);
    for (const r of m.toolResults ?? []) resultRow.set(r.tool_use_id, i);
  });

  let next = 0;
  const findText = (role: Message['role'], text: string): { row: number; whole: boolean } | undefined => {
    for (let i = next; i < Math.min(rows.length, next + LOOKAHEAD); i++) {
      const row = rows[i]!;
      if (row.role !== role) continue;
      const own = row.text.trim();
      if (own === text) return { row: i, whole: true };
      if (own.length > 0 && own.includes(text)) return { row: i, whole: false };
    }
    return undefined;
  };

  for (const message of api as ApiMessage[]) {
    if (!message || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && typeof block['id'] === 'string') {
        const row = useRow.get(block['id']);
        if (row !== undefined) next = Math.max(next, row + 1);
      } else if (block.type === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        const id = block['tool_use_id'];
        const row = resultRow.get(id);
        if (row !== undefined) next = Math.max(next, row + 1);
        const media = countMedia(block['content']);
        if (media.images + media.documents > 0) hidden.media.set(id, media);
      } else if (block.type === 'text' && typeof block['text'] === 'string') {
        const text = block['text'].trim();
        if (!text) continue;
        const found = findText(message.role, text);
        if (found) {
          next = found.whole ? found.row + 1 : found.row;
          continue;
        }
        if (message.role !== 'user') continue;
        const kind = hiddenKind(text);
        if (kind) hidden.extras.push({ before: next, kind, text });
      } else if (message.role === 'user' && (block.type === 'image' || block.type === 'document')) {
        const what = block.type === 'image' ? 'an image' : 'a document';
        hidden.extras.push({
          before: next,
          kind: 'media',
          text: `[lopper: ${what} the user attached around here was removed by compaction; ask for it again if you need it]`,
        });
      }
    }
  }
  return hidden;
}
