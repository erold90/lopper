import { describe, expect, it } from 'vitest';

import { decide, fixedFrom, limits, readConfig, report, type Entry } from '../plugin/hooks/lopper.ts';
import { readHidden } from '../plugin/src/hidden.ts';
import type { Message } from '../plugin/src/prune.ts';
import { assistant, call, conversation, user } from './helpers.ts';

const config = readConfig({});
const MAIN = { window: 1_000_000, fixed: 45_000 };

describe('decide', () => {
  it('prunes when that frees a lot', () => {
    const v = decide(conversation(60), config, { ...MAIN, tokens: 420_000 });
    expect(v.kind).toBe('pruned');
    if (v.kind === 'pruned') expect(v.after).toBeLessThan(v.before);
  });

  it('hands over to the summary when there is nothing to prune', () => {
    const v = decide([user('a'.repeat(900_000)), assistant('ok')], config, { ...MAIN, tokens: 520_000 });
    expect(v).toMatchObject({ kind: 'summary', refusal: { why: 'nothing' } });
  });

  it('uses the tight pass when the first one is not enough', () => {
    const v = decide(conversation(160, 12_000), config, { ...MAIN, tokens: 650_000 });
    expect(v.kind).toBe('pruned');
    if (v.kind === 'pruned') expect(v.pass).toBe(2);
  });

  it('does not prune again when the context has barely grown since the last time', () => {
    expect(decide(conversation(60), config, { ...MAIN, tokens: 200_000 }, undefined, 190_000)).toMatchObject({
      kind: 'summary',
      refusal: { why: 'grew-little' },
    });
    expect(decide(conversation(60), config, { ...MAIN, tokens: 420_000 }, undefined, 190_000).kind).toBe('pruned');
  });

  it('with a large fixed context, a prune that removes nothing is refused', () => {
    // 125k tokens of which 110k are tools and memory: the rows hold nothing to cut.
    const rows: Message[] = [user('hello'), assistant('hi'), ...call('Bash', { command: 'ls' }, 'a b c'), assistant('done')];
    const v = decide(rows, config, { window: 200_000, fixed: 110_000, tokens: 125_000 });
    expect(v.kind).toBe('summary');
  });

  it('leaving room under the threshold is required only when lopper itself asked', () => {
    // 950k of which a lot is prunable but the rest stays big: fine at the engine's limit.
    const big = conversation(100, 12_000);
    for (let i = 0; i < 15; i++) big.unshift(user('x'.repeat(20_000)), assistant('y'.repeat(20_000)));
    expect(decide(big, config, { ...MAIN, tokens: 950_000 }, undefined, undefined, 'plugin')).toMatchObject({
      kind: 'summary',
      refusal: { why: 'still-big' },
    });
    expect(decide(big, config, { ...MAIN, tokens: 950_000 }, undefined, undefined, 'auto').kind).toBe('pruned');
    expect(decide(big, config, { ...MAIN, tokens: 950_000 }, undefined, undefined, 'manual').kind).toBe('pruned');
  });

  it('scales threshold and target to the window', () => {
    expect(limits(config, 1_000_000)).toEqual({ threshold: 300_000, target: 150_000 });
    expect(limits(config, 200_000)).toEqual({ threshold: 120_000, target: 72_000 });
  });
});

describe('fixedFrom', () => {
  it('adds up the used categories except the messages', () => {
    const categories = [
      { name: 'System prompt', tokens: 1472, kind: 'used' },
      { name: 'System tools', tokens: 11292, kind: 'used' },
      { name: 'System tools (deferred)', tokens: 21578, kind: 'deferred' },
      { name: 'Skills', tokens: 2183, kind: 'used' },
      { name: 'Messages', tokens: 311, kind: 'used' },
      { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
    ];
    expect(fixedFrom(categories)).toBe(1472 + 11292 + 2183);
    expect(fixedFrom(undefined)).toBeUndefined();
  });
});

describe('readHidden', () => {
  // The shape seen live on Claude Code 2.1.283: a skill, then a prompt with an @file.
  const rows: Message[] = [
    user('<command-message>codeword</command-message>\n<command-name>/codeword</command-name>'),
    assistant('The codeword is PAPAYA-42.'),
    user('Summarize @notes.txt in one line.'),
    assistant(''),
    assistant('118 blue crates leave Rotterdam on Tuesday.'),
  ];
  const api = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>\n# Environment\nYou have been invoked…\n</system-reminder>' },
        { type: 'text', text: '<system-reminder>\nToday\'s date is 2026-09-26.\n</system-reminder>' },
        { type: 'text', text: '<command-message>codeword</command-message>\n<command-name>/codeword</command-name>\n' },
        { type: 'text', text: 'Base directory for this skill: /p/.claude/skills/codeword\n\nRemember: the codeword is PAPAYA-42.' },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'The codeword is PAPAYA-42.' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/p/notes.txt"}\n</system-reminder>' },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>\nResult of calling the Read tool: 1\t118 blue crates…\n</system-reminder>' },
        { type: 'text', text: '<system-reminder>\n<total_tokens>15000000 tokens left</total_tokens>\n</system-reminder>' },
        { type: 'image', source: {} },
        { type: 'text', text: 'Summarize @notes.txt in one line.' },
      ],
    },
    { role: 'assistant', content: [{ type: 'thinking' }, { type: 'text', text: '118 blue crates leave Rotterdam on Tuesday.' }] },
  ];

  it('finds the skill, the attached file and the pasted image, and where they go', () => {
    const { extras } = readHidden(rows, api);
    expect(extras.map((x) => [x.before, x.kind])).toEqual([
      [1, 'instructions'],
      [2, 'attachment'],
      [2, 'attachment'],
      [2, 'media'],
    ]);
    expect(extras[0]!.text).toContain('PAPAYA-42');
  });

  it('leaves out the reminders the engine adds back by itself', () => {
    const { extras } = readHidden(rows, api);
    expect(extras.some((x) => x.text.includes('# Environment') || x.text.includes('total_tokens'))).toBe(false);
  });

  it('counts images and documents inside tool results', () => {
    const [use, result] = call('Read', { file_path: '/p/a.pdf' }, 'PDF file read');
    const id = use.toolUses[0]!.tool_use_id;
    const { media } = readHidden([user('read'), use, result], [
      { role: 'user', content: [{ type: 'text', text: 'read' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'document' }, { type: 'image' }] }] },
    ]);
    expect(media.get(id)).toEqual({ images: 1, documents: 1 });
  });

  it('with a view cut at 4096 messages, puts nothing back before the first known call', () => {
    const many: Message[] = [];
    const api: { role: string; content: Record<string, unknown>[] }[] = [];
    for (let i = 0; i < 2100; i++) {
      const [use, result] = call('Bash', { command: `echo ${i}` }, `${i}`);
      many.push(user(`prompt ${i}`), use, result);
      if (i >= 50) {
        api.push({ role: 'user', content: [{ type: 'text', text: `prompt ${i}` }] });
        api.push({ role: 'assistant', content: [{ type: 'tool_use', id: use.toolUses[0]!.tool_use_id, name: 'Bash', input: {} }] });
        api.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: result.toolResults![0]!.tool_use_id, content: `${i}` }] });
      }
    }
    expect(api.length).toBeGreaterThanOrEqual(4096);
    expect(readHidden(many, api.slice(-4096)).extras).toEqual([]);
  });

  it('copes with anything that is not a list', () => {
    expect(readHidden(rows, { deny: 'no' })).toEqual({ media: new Map(), extras: [] });
  });
});

describe('report', () => {
  it('lists the latest compactions, in both languages', () => {
    const history: Entry[] = [
      { at: '2026-09-26T10:00:00.000Z', trigger: 'plugin', kind: 'pruned', before: 480_000, after: 124_000, trimmed: 32, superseded: 1, media: 29, ms: 11 },
      { at: '2026-09-26T11:00:00.000Z', trigger: 'auto', kind: 'summary', before: 700_000, reason: 'pruning would free only ~3k tokens' },
    ];
    expect(report(history, config)).toContain('480k → ~124k: 32 trimmed');
    expect(report(history, readConfig({ language: 'it' }))).toContain('riassunto normale');
    expect(report([], config)).toContain('No compaction recorded yet.');
  });
});
