import { describe, expect, it } from 'vitest';

import { readConfig, type Store } from '../opencode/lopper.ts';
import { applyCut, computeCut, endOf, engine, resultText, type Msg, type Part } from '../opencode/v2.ts';
import { long } from './helpers.ts';

let n = 0;
const id = (p: string) => `${p}_${String(++n).padStart(5, '0')}`;
const SID = 'ses_v2';

/** opencode 2 hands over instances of its own message class; lopper must keep it. */
class OcMessage implements Msg {
  id?: string;
  role: string;
  content: Part[];
  metadata?: Record<string, unknown>;
  constructor(m: Msg) {
    this.id = m.id;
    this.role = m.role;
    this.content = m.content;
    if (m.metadata) this.metadata = m.metadata;
  }
}

const user = (text: string, extra: Part[] = []): Msg => new OcMessage({ id: id('msg'), role: 'user', content: [{ type: 'text', text }, ...extra], metadata: {} });
const assistant = (content: Part[]): Msg => new OcMessage({ id: id('msg'), role: 'assistant', content, metadata: {} });
const results = (...content: Part[]): Msg => new OcMessage({ role: 'tool', content });
const note = (text: string): Msg => new OcMessage({ role: 'system', content: [{ type: 'text', text }] });

const text = (t: string): Part => ({ type: 'text', text: t });
const reasoning = (t: string): Part => ({ type: 'reasoning', text: t, providerMetadata: { venice: {} } });

/** A call and its result, the way opencode 2 sends them: a part in the response, a part in the next `tool` message. */
function call(name: string, input: Record<string, unknown>, output: string, type = 'text'): [Part, Part] {
  const cid = id('call');
  return [
    { type: 'tool-call', id: cid, name, input, providerExecuted: false },
    { type: 'tool-result', id: cid, name, result: { type, value: output }, cache: undefined },
  ];
}

const memory = (): Store & { logs: unknown[] } => {
  const saved = new Map<string, unknown>();
  const logs: unknown[] = [];
  return {
    logs,
    load: (s) => saved.get(s) as never,
    save: (s, v) => void saved.set(s, JSON.parse(JSON.stringify({ firstId: v.firstId, spec: v.cut?.spec ?? v.spec, refusedAt: v.refusedAt }))),
    drop: (s) => void saved.delete(s),
    log: (e) => void logs.push(e),
  };
};

const resultOf = (m: Msg, i = 0): string => resultText(m.content.filter((p) => p.type === 'tool-result')[i]?.['result'] as never);

/** An old turn heavy with tool output, then enough recent talk to push it out of the recent zone. */
function session(): Msg[] {
  const [makeCall, makeResult] = call('shell', { command: 'make' }, long(60_000, 'build log line'));
  const [skillCall, skillResult] = call('skill', { id: 'anybrowser' }, long(20_000, 'skill instruction'));
  const [readCall, readResult] = call('read', { path: '/repo/a.ts' }, long(30_000, 'old a.ts'));
  const [read2Call, read2Result] = call('read', { path: '/repo/a.ts' }, long(30_000, 'new a.ts'));
  return [
    user('build it'),
    assistant([reasoning(long(8_000, 'thinking about the build')), makeCall, skillCall]),
    results(makeResult, skillResult),
    assistant([text('built'), readCall]),
    results(readResult),
    assistant([read2Call]),
    results(read2Result),
    assistant([text('done')]),
    user('now something else'),
    assistant([text(long(140_000, 'a long explanation in the recent zone'))]),
    note('The available tools have changed.'),
    user('and then?'),
  ];
}

describe('opencode 2: the cut', () => {
  it('finds where a cut ends, past the results that carry no id', () => {
    const msgs = session();
    expect(endOf(msgs, msgs[1]!.id!)).toBe(2);
    expect(endOf(msgs, msgs[9]!.id!)).toBe(10);
    expect(endOf(msgs, 'msg_missing')).toBe(-1);
  });

  it('trims old results, supersedes re-read files, keeps skills whole, drops finished reasoning', () => {
    const msgs = session();
    const before = msgs.map((m) => JSON.stringify(m));
    const cut = computeCut(msgs, {
      boundaryId: msgs[11]!.id!,
      lastUserId: msgs[11]!.id!,
      pass: 1,
      recentTokens: 30_000,
      charsPerToken: 3.3,
      before: 0,
      at: 0,
    })!;
    const sent = msgs.slice();
    applyCut(sent, cut, 'it');
    expect(resultOf(sent[2]!, 0).length).toBeLessThan(5_000);
    expect(resultOf(sent[2]!, 1)).toBe(resultOf(msgs[2]!, 1));
    expect(resultOf(sent[4]!)).toMatch(/\/repo\/a\.ts was read again later/);
    // The latest read is old too, so it is trimmed, but never called superseded.
    expect(resultOf(sent[6]!)).not.toMatch(/was read again/);
    expect(resultOf(sent[6]!)).toMatch(/^1: new a\.ts|new a\.ts 1/);
    expect(sent[1]!.content.some((p) => p.type === 'reasoning')).toBe(false);
    // Copies of the same class; the originals are untouched.
    expect(sent[2]).toBeInstanceOf(OcMessage);
    expect(sent[2]).not.toBe(msgs[2]);
    expect(msgs.map((m) => JSON.stringify(m))).toEqual(before);
    // What nothing changed is the same object.
    expect(sent[8]).toBe(msgs[8]);
    expect(sent[10]).toBe(msgs[10]);
  });

  it('keeps the result kind, and turns content results into one text plus their files', () => {
    const [jsonCall, jsonResult] = call('websearch', { query: 'x' }, '', 'json');
    (jsonResult['result'] as { value: unknown }).value = { hits: long(50_000, 'hit') };
    const [errCall, errResult] = call('shell', { command: 'boom' }, long(50_000, 'stack frame'), 'error');
    const msgs = [
      user('search'),
      assistant([jsonCall, errCall]),
      results(jsonResult, errResult),
      assistant([text('ok')]),
      user('later'),
      assistant([text(long(140_000, 'recent'))]),
      user('now'),
    ];
    const cut = computeCut(msgs, { boundaryId: msgs[6]!.id!, lastUserId: msgs[6]!.id!, pass: 1, recentTokens: 30_000, charsPerToken: 3.3, before: 0, at: 0 })!;
    applyCut(msgs, cut);
    const [j, err] = msgs[2]!.content as { result: { type: string; value: unknown } }[];
    expect(j!.result.type).toBe('text');
    expect(String(j!.result.value).length).toBeLessThan(5_000);
    expect(err!.result.type).toBe('error');
  });

  it('replaces media the user attached in a finished turn with a note', () => {
    const media: Part = { type: 'media', media: { source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' } }, filename: 'shot.png' };
    const msgs = [user('look', [media]), assistant([text('seen')]), user('and now')];
    const cut = computeCut(msgs, { boundaryId: msgs[2]!.id!, lastUserId: msgs[2]!.id!, pass: 1, recentTokens: 30_000, charsPerToken: 3.3, before: 0, at: 0 })!;
    applyCut(msgs, cut, 'it');
    expect(msgs[0]!.content.some((p) => p.type === 'media')).toBe(false);
    expect(JSON.stringify(msgs[0]!.content)).toMatch(/shot\.png/);
  });
});

describe('opencode 2: the engine', () => {
  const config = readConfig({ threshold: 100_000, target: 60_000, recentTokens: 30_000 });

  it('does nothing under the threshold', () => {
    const msgs = session();
    const sent = msgs.slice();
    expect(engine(config, memory()).transform({ sessionID: SID, messages: sent, context: 50_000 })).toBeUndefined();
    expect(sent.every((m, i) => m === msgs[i])).toBe(true);
  });

  it('cuts past the threshold, then sends the very same bytes until the context grows again', () => {
    const store = memory();
    const e = engine(config, store);
    const stored = session();
    const first = sessionLike(stored);
    const verdict = e.transform({ sessionID: SID, messages: first, context: 120_000 });
    expect(verdict?.kind).toBe('cut');
    expect(store.logs).toHaveLength(1);
    const after = verdict?.kind === 'cut' ? verdict.cut.spec.after : 0;
    // The next call is built afresh from storage with one more step; everything the cut covered goes out byte for byte.
    const again = [...sessionLike(stored), assistant([text('one more step')])];
    expect(e.transform({ sessionID: SID, messages: again, context: after + 2_000 })).toBeUndefined();
    expect(JSON.stringify(again.slice(0, stored.length))).toBe(JSON.stringify(first));
    expect(again[stored.length]!.content).toEqual([text('one more step')]);
    expect(store.logs).toHaveLength(1);
  });

  it('computes the same cut again after a restart', () => {
    const store = memory();
    const one = session();
    const a = one.slice();
    engine(config, store).transform({ sessionID: SID, messages: a, context: 120_000 });
    const b = one.slice();
    engine(config, store).transform({ sessionID: SID, messages: b, context: 30_000 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('after a restart with no size reported yet, estimates with the cut already made, and does not try again', () => {
    const store = memory();
    const stored = session();
    const a = sessionLike(stored);
    engine(config, store).transform({ sessionID: SID, messages: a, context: 120_000 });
    expect(store.logs).toHaveLength(1);
    const b = sessionLike(stored);
    expect(engine(config, store).transform({ sessionID: SID, messages: b, fixedChars: 100_000 })).toBeUndefined();
    expect(store.logs).toHaveLength(1);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('estimates the size from the messages when no step was reported yet', () => {
    const store = memory();
    const verdict = engine(config, store).transform({ sessionID: SID, messages: session(), fixedChars: 100_000 });
    expect(verdict?.kind).toBe('cut');
  });

  it('applies the current cut to a summary call without deciding a new one', () => {
    const store = memory();
    const e = engine(config, store);
    const msgs = session();
    expect(e.transform({ sessionID: SID, messages: msgs.slice(), context: 300_000, readOnly: true })).toBeUndefined();
    expect(store.logs).toHaveLength(0);
  });
});

/** The stored messages again, as opencode builds them for the next call: fresh objects, same content. */
function sessionLike(sent: readonly Msg[]): Msg[] {
  return sent.map((m) => new OcMessage(JSON.parse(JSON.stringify(m)) as Msg));
}
