import { describe, expect, it } from 'vitest';

import { cut, messageChars, prune, regroup, salvage, tighter, DEFAULT_OPTIONS, type Message } from '../plugin/src/prune.ts';
import { assistant, call, conversation, filler, idOf, long, user } from './helpers.ts';

describe('cut', () => {
  it('leaves short text alone', () => {
    expect(cut('short', { head: 10, tail: 5 })).toBe('short');
  });

  it('keeps head and tail and says how much went', () => {
    const text = long(10_000);
    const out = cut(text, { head: 900, tail: 300 });
    expect(out.length).toBeLessThan(2_000);
    expect(out).toMatch(/\[lopper: \d+ chars of this result removed here to save context, not an error/);
    const head = out.slice(0, out.indexOf('[lopper:'));
    const tail = out.slice(out.indexOf(']\n') + 2);
    const removed = Number(/(\d+) chars of this result/.exec(out)?.[1]);
    expect(text.startsWith(head)).toBe(true);
    expect(text.endsWith(tail)).toBe(true);
    expect(head.length + removed + tail.length).toBe(text.length);
  });

  it('never makes the text longer', () => {
    for (let n = 1_000; n < 3_000; n += 37) {
      const text = long(n);
      expect(cut(text, { head: 900, tail: 300 }).length).toBeLessThanOrEqual(text.length);
    }
  });

  it('does not split an emoji', () => {
    const text = `${'a'.repeat(899)}😀${'b'.repeat(5_000)}`;
    expect(cut(text, { head: 900, tail: 300 })).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('cut twice: one note, and the counts add up', () => {
    const text = `${long(20_000)}\nError: boom at /srv/app/a.ts\n${long(20_000)}`;
    const once = cut(text, DEFAULT_OPTIONS.middle);
    const twice = cut(once, DEFAULT_OPTIONS.old);
    expect(twice.match(/\[lopper:/g)).toHaveLength(1);
    const head = twice.slice(0, twice.indexOf('[lopper:'));
    const tail = twice.slice(twice.indexOf(']\n') + 2);
    const removed = Number(/(\d+) chars of this result/.exec(twice)?.[1]);
    expect(head.length + removed + tail.length).toBe(text.length);
    expect(twice).toContain('Error: boom');
  });

  it('does not mistake source code for errors', () => {
    const code = `${long(3_000)}\n  /** Returns true if properties cannot be added. */\ninterface Error {\n  message: string;\n}\n${long(3_000)}`;
    expect(salvage(code)).not.toContain('cannot');
    expect(salvage(code)).not.toContain('interface Error');
  });

  it('salvages nothing from a file it read: reading it again gives it all back', () => {
    const messages: Message[] = [user('read')];
    messages.push(...call('Read', { file_path: '/p/a.ts' }, `${long(6_000)}\nError: in a comment\n${long(6_000)}`));
    messages.push(assistant('Read it.'));
    messages.push(...filler(30));
    const text = prune(messages).messages[2]!.toolResults![0]!.text;
    expect(text).toContain('removed here to save context, not an error. Run the tool again');
    expect(text).not.toContain('they included');
  });

  it('salvages errors, paths and URLs from the part it cuts', () => {
    const middle = `${long(3_000)}\nError: cannot find module /Users/x/app/src/a.ts\n${long(3_000)}\nsee https://example.com/doc`;
    const saved = salvage(middle);
    expect(saved).toContain('Error: cannot find module');
    expect(saved).toContain('https://example.com/doc');
    expect(saved.length).toBeLessThanOrEqual(420);
  });
});

/** Every assistant message with calls is followed at once by a message with all their results. */
function paired(ms: Message[]): boolean {
  return ms.every((m, i) => {
    if (m.role !== 'assistant' || m.toolUses.length === 0) return true;
    const next = ms[i + 1];
    if (!next) return true; // calls still running at the end
    const ids = new Set((next.toolResults ?? []).map((r) => r.tool_use_id));
    return m.toolUses.every((u) => ids.has(u.tool_use_id));
  });
}

describe('regroup', () => {
  it('puts parallel calls in one message and their results in the next', () => {
    const calls = [call('Read', { file_path: '/a' }, 'A'), call('Read', { file_path: '/b' }, 'B'), call('Read', { file_path: '/c' }, 'C')];
    const rows: Message[] = [user('read three'), assistant('Reading.'), ...calls.map((c) => c[0]), ...calls.map((c) => c[1]), assistant('Done.')];
    const out = regroup(rows);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(out[1]!.text).toBe('Reading.');
    expect(out[1]!.toolUses).toHaveLength(3);
    expect(out[2]!.toolResults).toHaveLength(3);
    expect(paired(out)).toBe(true);
  });

  it('keeps sequential calls as they are', () => {
    const a = call('Bash', { command: 'a' }, 'a');
    const b = call('Bash', { command: 'b' }, 'b');
    const out = regroup([user('go'), a[0], a[1], b[0], b[1]]);
    expect(out).toHaveLength(5);
    expect(paired(out)).toBe(true);
  });

  it('moves text that landed between calls and results to after the results', () => {
    const a = call('Read', { file_path: '/a' }, 'A');
    const b = call('Read', { file_path: '/b' }, 'B');
    const out = regroup([user('go'), a[0], b[0], user('<attached file>'), a[1], b[1], assistant('ok')]);
    expect(out.map((m) => m.text || (m.toolResults ? 'results' : 'calls'))).toEqual(['go', 'calls', 'results', '<attached file>', 'ok']);
    expect(paired(out)).toBe(true);
  });
});

describe('prune', () => {
  it('leaves every call paired with its results, parallel calls included', () => {
    const messages: Message[] = [user('audit')];
    for (let round = 0; round < 12; round++) {
      const batch = [0, 1, 2, 3].map((k) => call('Read', { file_path: `/p/${round}-${k}.ts` }, long(20_000)));
      messages.push(assistant(`Round ${round}.`), ...batch.map((c) => c[0]), ...batch.map((c) => c[1]));
    }
    messages.push(assistant('All read.'));
    expect(paired(prune(messages).messages)).toBe(true);
    expect(paired(prune(messages, tighter(DEFAULT_OPTIONS)).messages)).toBe(true);
  });

  it('never changes what the user or the assistant wrote', () => {
    const messages = conversation(40);
    const texts = (ms: Message[]) => ms.filter((m) => m.text.length > 0).map((m) => `${m.role}:${m.text}`);
    expect(texts(prune(messages).messages)).toEqual(texts(messages));
  });

  it('never drops a call or a result', () => {
    const messages = conversation(40);
    const ids = (ms: Message[]) =>
      ms.flatMap((m) => [...m.toolUses.map((u) => `u:${u.tool_use_id}`), ...(m.toolResults ?? []).map((r) => `r:${r.tool_use_id}`)]);
    expect(ids(prune(messages).messages)).toEqual(ids(messages));
  });

  it('returns only rebuilt messages, with no handle', () => {
    expect(prune(conversation(5)).messages.every((m) => m.handle === undefined)).toBe(true);
  });

  it('trims old results and keeps the recent ones whole', () => {
    const result = prune(conversation(40));
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore * 0.5);
    expect(result.decisions.at(-1)).toMatchObject({ zone: 'recent', action: 'kept' });
    expect(result.decisions[0]!.action).toBe('trimmed');
  });

  it('keeps the result and its copy on the call in step', () => {
    const { messages } = prune(conversation(40));
    const copies = new Map<string, string>();
    for (const m of messages) for (const u of m.toolUses) if (u.text !== undefined) copies.set(u.tool_use_id, u.text);
    for (const m of messages) for (const r of m.toolResults ?? []) expect(copies.get(r.tool_use_id)).toBe(r.text);
  });

  it('drops rows left empty (thinking, images)', () => {
    const result = prune([user('hi'), assistant(''), assistant('answer')]);
    expect(result.messages).toHaveLength(2);
    expect(result.stats.emptyDropped).toBe(1);
  });

  it('pruning twice gives no nested notes and honest counts', () => {
    const messages = conversation(60, 30_000);
    const original = new Map(messages.flatMap((m) => m.toolResults ?? []).map((r) => [r.tool_use_id, r.text]));
    const once = prune(messages).messages;
    const twice = prune(once, tighter(DEFAULT_OPTIONS)).messages;
    for (const r of twice.flatMap((m) => m.toolResults ?? [])) {
      expect((r.text.match(/\[lopper:/g) ?? []).length).toBeLessThanOrEqual(1);
      const n = /(\d+) chars of this result removed here/.exec(r.text);
      if (!n) continue;
      const head = r.text.slice(0, r.text.indexOf('[lopper:'));
      const tail = r.text.slice(r.text.indexOf(']\n') + 2);
      expect(head.length + Number(n[1]) + tail.length).toBe(original.get(r.tool_use_id)!.length);
    }
  });

  describe('superseded results', () => {
    it('a read of the same file later supersedes an older read', () => {
      const messages: Message[] = [user('read a.ts')];
      messages.push(...call('Read', { file_path: '/p/a.ts' }, long(8_000, 'old version')));
      messages.push(...filler(30));
      messages.push(...call('Read', { file_path: '/p/a.ts' }, long(8_000, 'new version')));
      const result = prune(messages);
      expect(result.decisions[0]).toMatchObject({ action: 'superseded', reason: '/p/a.ts was read again later' });
      expect(result.decisions.at(-1)!.action).toBe('kept');
    });

    it('a "file unchanged" re-read does not supersede the real read', () => {
      for (const stub of [
        'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.',
        'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.',
        '<system-reminder>This file is already in your context (see "Context")</system-reminder>',
      ]) {
        const messages: Message[] = [user('read a.ts')];
        messages.push(...call('Read', { file_path: '/p/a.ts' }, long(8_000)));
        messages.push(...filler(30));
        messages.push(...call('Read', { file_path: '/p/a.ts' }, stub));
        expect(prune(messages).decisions[0]!.action).not.toBe('superseded');
      }
    });

    it('a partial read does not supersede, nor does a whole read that came back truncated', () => {
      const partials: [Record<string, unknown>, string][] = [
        [{ file_path: '/p/a.ts', offset: 10, limit: 20 }, long(500)],
        [{ file_path: '/p/a.pdf', pages: '6-10' }, long(8_000)],
        [{ file_path: '/p/a.ts' }, `${long(8_000)}\n[Truncated: PARTIAL view — lines 1-2000 of 5000]`],
      ];
      for (const [input, result] of partials) {
        const messages: Message[] = [user('read')];
        messages.push(...call('Read', { file_path: input['file_path'] as string, offset: 3000 }, long(8_000)));
        messages.push(...filler(30));
        messages.push(...call('Read', input, result));
        expect(prune(messages).decisions[0]!.action).not.toBe('superseded');
      }
    });

    it('a Write of the file supersedes earlier reads of it', () => {
      const messages: Message[] = [user('rewrite a.ts')];
      messages.push(...call('Read', { file_path: '/p/a.ts' }, long(8_000)));
      messages.push(...filler(30));
      messages.push(...call('Write', { file_path: '/p/a.ts', content: 'new' }, 'File written'));
      expect(prune(messages).decisions[0]).toMatchObject({ action: 'superseded', reason: '/p/a.ts was rewritten later' });
    });

    it('the same Bash command twice is not superseded: the directory may differ', () => {
      const messages: Message[] = [user('list')];
      messages.push(...call('Bash', { command: 'ls -la' }, long(6_000, 'dir one')));
      messages.push(...filler(30));
      messages.push(...call('Bash', { command: 'ls -la' }, long(6_000, 'dir two')));
      expect(prune(messages).decisions[0]!.action).not.toBe('superseded');
    });

    it('an error does not supersede an earlier good result', () => {
      const messages: Message[] = [user('fetch')];
      messages.push(...call('WebFetch', { url: 'https://example.com' }, long(6_000, 'page')));
      messages.push(...filler(30));
      messages.push(...call('WebFetch', { url: 'https://example.com' }, 'Error: network', true));
      expect(prune(messages).decisions[0]!.action).not.toBe('superseded');
    });
  });

  it('trims long inputs of old calls, not of recent ones, and only once', () => {
    const messages: Message[] = [user('write')];
    messages.push(...call('Write', { file_path: '/p/b.ts', content: long(10_000) }, 'File written'));
    messages.push(...filler(30));
    messages.push(...call('Write', { file_path: '/p/c.ts', content: long(10_000) }, 'File written'));
    const first = prune(messages);
    const input = (ms: Message[], path: string) =>
      String(ms.flatMap((m) => m.toolUses).find((u) => u.input['file_path'] === path)!.input['content']);
    expect(input(first.messages, '/p/b.ts').length).toBeLessThan(1_000);
    expect(input(first.messages, '/p/c.ts').length).toBe(10_000);
    const second = prune(first.messages, tighter(DEFAULT_OPTIONS));
    const again = input(second.messages, '/p/b.ts');
    expect(again.match(/\[lopper:/g)).toHaveLength(1);
    const kept = again.slice(0, again.indexOf('…[lopper:'));
    expect(kept.length + Number(/(\d+) chars of this field removed/.exec(again)?.[1])).toBe(10_000);
  });

  it('gives errors a longer head', () => {
    const messages: Message[] = [user('try')];
    messages.push(...call('Bash', { command: 'a' }, long(20_000), true));
    messages.push(...call('Bash', { command: 'b' }, long(20_000)));
    messages.push(...filler(40));
    const result = prune(messages);
    expect(result.decisions[0]!.charsAfter).toBeGreaterThan(result.decisions[1]!.charsAfter);
  });

  it('notes the media it removes, and how to get it back', () => {
    const messages: Message[] = [user('look')];
    messages.push(...call('mcp__computer-use__screenshot', {}, ''));
    messages.push(...call('Read', { file_path: '/p/spec.pdf' }, 'PDF file read: /p/spec.pdf'));
    const media = new Map([
      [idOf(messages[1]!), { images: 1, documents: 0 }],
      [idOf(messages[3]!), { images: 0, documents: 1 }],
    ]);
    const result = prune(messages, { media });
    expect(result.stats.mediaRemoved).toBe(2);
    expect(result.messages[2]!.toolResults![0]!.text).toBe(
      '[lopper: removed an image from this result; run the tool again if you need to see it]',
    );
    expect(result.messages[4]!.toolResults![0]!.text).toContain('removed a document from this result; read /p/spec.pdf again');
  });

  it('puts hidden context back in place, cutting only old attachments', () => {
    const messages: Message[] = [user('/codeword'), assistant('Noted.')];
    messages.push(...filler(40));
    messages.push(user('What does notes.txt say?'), assistant('It says hi.'));
    const skill = `Base directory for this skill: /p/.claude/skills/codeword\n\n${long(9_000, 'instruction')}`;
    const file = `<system-reminder>\nResult of calling the Read tool: ${long(9_000, 'attached')}\n</system-reminder>`;
    const result = prune(messages, {
      extras: [
        { before: 1, kind: 'instructions', text: skill },
        { before: messages.length - 2, kind: 'attachment', text: file },
        { before: 2, kind: 'attachment', text: file },
      ],
    });
    const out = result.messages;
    expect(out[0]!.text).toBe('/codeword');
    expect(out[1]!.text).toBe(skill);
    expect(out[2]!.text).toBe('Noted.');
    expect(out[3]!.text).toContain('removed here to save context');
    const recentIndex = out.findIndex((m) => m.text === 'What does notes.txt say?');
    expect(out[recentIndex - 1]!.text).toBe(file);
    expect(result.stats.extras).toBe(3);
  });

  it('never trims results the model has not read yet, even in the tight pass', () => {
    // A subagent read ten files in parallel and was compacted before answering.
    const messages: Message[] = [user('read these ten files')];
    const uses: Message[] = [];
    const results: Message[] = [];
    for (let i = 0; i < 10; i++) {
      const [use, result] = call('Read', { file_path: `/p/f${i}.ts` }, long(45_000, `file ${i}`));
      uses.push(use);
      results.push(result);
    }
    messages.push(...uses, ...results);
    const result = prune(messages, tighter(DEFAULT_OPTIONS));
    expect(result.decisions.every((d) => d.action === 'kept')).toBe(true);
    expect(result.stats.charsAfter).toBe(result.stats.charsBefore);
  });

  it('trims even a recent result when it is huge', () => {
    const messages: Message[] = [user('read it all')];
    messages.push(...call('Bash', { command: 'cat huge.log' }, long(200_000)));
    const result = prune(messages);
    expect(result.decisions[0]!.zone).toBe('recent');
    expect(result.decisions[0]!.charsAfter).toBeLessThan(70_000);
  });

  it('leaves a call with no result alone', () => {
    const messages: Message[] = [
      user('go'),
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool: 'Bash', input: { command: 'sleep 1' } }] },
    ];
    const result = prune(messages);
    expect(result.messages[1]!.toolUses[0]!.tool_use_id).toBe('x');
    expect(result.decisions[0]!.action).toBe('kept');
  });

  it('counts characters as they were before pruning', () => {
    const messages = conversation(3);
    expect(prune(messages).stats.charsBefore).toBe(messages.reduce((s, m) => s + messageChars(m), 0));
  });
});
