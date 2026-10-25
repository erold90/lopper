import { describe, expect, it } from 'vitest';

import {
  applyCut,
  computeCut,
  contextTokens,
  engine,
  limits,
  readConfig,
  sentChars,
  type CutSpec,
  type OcMessage,
  type OcPart,
  type Store,
} from '../opencode/lopper.ts';
import { long } from './helpers.ts';

let n = 0;
const id = (p: string) => `${p}_${String(++n).padStart(5, '0')}`;
const SID = 'ses_test';

function user(text: string, extra: OcPart[] = []): OcMessage {
  const mid = id('msg');
  return { info: { id: mid, sessionID: SID, role: 'user' }, parts: [{ id: id('prt'), type: 'text', text }, ...extra] };
}

function tool(name: string, input: Record<string, unknown>, output: string, attachments?: OcPart[]): OcPart {
  return {
    id: id('prt'),
    type: 'tool',
    tool: name,
    callID: id('call'),
    state: { status: 'completed', input, output, title: '', metadata: {}, time: { start: 1, end: 2 }, ...(attachments ? { attachments } : {}) },
  };
}

function assistant(parts: OcPart[], tokens = 0): OcMessage {
  const mid = id('msg');
  return {
    info: { id: mid, sessionID: SID, role: 'assistant', tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts,
  };
}

const text = (t: string): OcPart => ({ id: id('prt'), type: 'text', text: t });
const reasoning = (t: string): OcPart => ({ id: id('prt'), type: 'reasoning', text: t, time: { start: 1 } });
const image: OcPart = { id: 'img', type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' };

const memory = (): Store & { saved: Map<string, unknown>; logs: unknown[] } => {
  const saved = new Map<string, unknown>();
  const logs: unknown[] = [];
  return {
    saved,
    logs,
    load: (s) => saved.get(s) as never,
    save: (s, v) => void saved.set(s, JSON.parse(JSON.stringify({ firstId: v.firstId, spec: v.cut?.spec ?? v.spec, refusedAt: v.refusedAt }))),
    drop: (s) => void saved.delete(s),
    log: (e) => void logs.push(e),
  };
};

const outputOf = (m: OcMessage, i = 0): string =>
  String(((m.parts.filter((p) => p.type === 'tool')[i]?.['state'] as { output: string }) ?? { output: '' }).output);

/** An old turn heavy with tool output, then enough recent talk to push it out of the recent zone. */
function session(): OcMessage[] {
  const big = long(60_000, 'build log line');
  return [
    user('build it'),
    assistant([reasoning(long(8_000, 'thinking about the build')), tool('bash', { command: 'make' }, big), tool('skill', { name: 'anybrowser' }, long(20_000, 'skill instruction'))]),
    assistant([tool('read', { filePath: '/repo/a.ts' }, long(30_000, 'old content of a.ts'))]),
    assistant([text('built')], 40_000),
    user('now look again', [image]),
    assistant([reasoning('short thought'), tool('read', { filePath: '/repo/a.ts' }, long(30_000, 'new content of a.ts'))]),
    assistant([text(long(120_000, 'a long answer the user asked for'))], 90_000),
    user('and now?'),
    assistant([reasoning('current thought'), tool('bash', { command: 'ls' }, long(40_000, 'unread listing'))], 120_000),
  ];
}

const spec = (msgs: OcMessage[], over: Partial<CutSpec> = {}): CutSpec => ({
  boundaryId: msgs[msgs.length - 1]!.info.id,
  lastUserId: [...msgs].reverse().find((m) => m.info.role === 'user')!.info.id,
  pass: 1,
  recentTokens: 30_000,
  charsPerToken: 3.3,
  before: 0,
  after: 0,
  at: 0,
  ...over,
});

describe('opencode: a cut', () => {
  it('trims old output, keeps a skill whole, notes a superseded read, keeps what the model has not read', () => {
    const msgs = session();
    const cut = computeCut(msgs, spec(msgs))!;
    const sent = [...msgs];
    applyCut(sent, cut);
    expect(outputOf(sent[1]!)).toContain('[lopper:⁠');
    expect(outputOf(sent[1]!).length).toBeLessThan(5_000);
    expect(outputOf(sent[1]!, 1)).toBe(outputOf(msgs[1]!, 1));
    expect(outputOf(sent[2]!)).toMatch(/\/repo\/a\.ts was read again later/);
    expect(outputOf(sent[8]!)).toBe(outputOf(msgs[8]!));
  });

  it('drops reasoning and images of finished turns only', () => {
    const msgs = session();
    const sent = [...msgs];
    applyCut(sent, computeCut(msgs, spec(msgs))!);
    expect(sent[1]!.parts.some((p) => p.type === 'reasoning')).toBe(false);
    expect(sent[5]!.parts.some((p) => p.type === 'reasoning')).toBe(false);
    expect(sent[8]!.parts.some((p) => p.type === 'reasoning')).toBe(true);
    expect(sent[4]!.parts.some((p) => p.type === 'file')).toBe(false);
    expect(sent[4]!.parts.find((p) => p.type === 'text' && p['synthetic'])?.['text']).toMatch(/removed a file the user attached/);
  });

  it('never touches what opencode stored, and never the words', () => {
    const msgs = session();
    const before = JSON.stringify(msgs);
    const sent = [...msgs];
    applyCut(sent, computeCut(msgs, spec(msgs))!);
    expect(JSON.stringify(msgs)).toBe(before);
    expect(sent[6]!.parts).toBe(msgs[6]!.parts);
    expect(sent.map((m) => m.parts.filter((p) => p.type === 'text' && !p['synthetic']).map((p) => p['text']))).toEqual(
      msgs.map((m) => m.parts.filter((p) => p.type === 'text').map((p) => p['text'])),
    );
  });

  it('is the same cut every time it is computed: the prompt cache holds', () => {
    const msgs = session();
    const a = [...msgs];
    const b = [...msgs];
    applyCut(a, computeCut(msgs, spec(msgs))!);
    applyCut(b, computeCut(msgs, spec(msgs))!);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('removes images a finished turn read, and says so', () => {
    const shot: OcPart = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,BBBB' };
    const msgs = [user('look'), assistant([tool('read', { filePath: '/s.png' }, 'Image read successfully', [shot])]), user('thanks'), assistant([text('ok')])];
    const sent = [...msgs];
    applyCut(sent, computeCut(msgs, spec(msgs))!);
    const st = sent[1]!.parts[0]!['state'] as { output: string; attachments: OcPart[] };
    expect(st.attachments).toEqual([]);
    expect(st.output).toMatch(/removed an image from this result; read \/s\.png again/);
    expect(sentChars(sent, 3.3)).toBeLessThan(sentChars(msgs, 3.3));
  });
});

describe('opencode: the engine', () => {
  const config = readConfig({ threshold: 100_000, target: 60_000, recentTokens: 30_000 });

  it('does nothing under the threshold', () => {
    const msgs = session().slice(0, 4);
    const sent = [...msgs];
    expect(engine(config, memory()).transform(sent)).toBeUndefined();
    expect(sent).toEqual(msgs);
  });

  it('cuts past the threshold, then sends the same cut until the context grows again', () => {
    const store = memory();
    const e = engine(config, store);
    const msgs = session();
    const first = [...msgs];
    const verdict = e.transform(first);
    expect(verdict?.kind).toBe('cut');
    expect(store.logs).toHaveLength(1);
    // The next request: one more step, reported at the size the cut left.
    const after = verdict?.kind === 'cut' ? verdict.cut.spec.after : 0;
    const next = [...msgs, assistant([text('done')], after + 2_000)];
    const second = [...next];
    expect(e.transform(second)).toBeUndefined();
    expect(JSON.stringify(second.slice(0, msgs.length))).toBe(JSON.stringify(first));
  });

  it('after a restart computes the very same cut from what it saved', () => {
    const store = memory();
    const msgs = session();
    const before = [...msgs];
    engine(config, store).transform(before);
    const after = [...msgs];
    engine(config, store).transform(after);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('refuses a cut that would free too little, and does not retry until the context grows', () => {
    const store = memory();
    const e = engine(readConfig({ threshold: 10_000 }), store);
    const msgs = [user('hi'), assistant([text('hello')], 50_000), user('again')];
    expect(e.transform([...msgs])?.kind).toBe('refused');
    expect(e.transform([...msgs])).toBeUndefined();
  });

  it('forgets its cut when opencode summarized the session (a new first message)', () => {
    const store = memory();
    const e = engine(config, store);
    const msgs = session();
    e.transform([...msgs]);
    const summarized = [user('summary of what we did'), assistant([text('ok')], 20_000)];
    expect(e.transform([...summarized])).toBeUndefined();
    expect((store.saved.get(SID) as { spec?: unknown } | undefined)?.spec).toBeUndefined();
  });

  it('reads the real context size from the last reply', () => {
    expect(contextTokens(session())).toBe(120_000);
  });
});

describe('opencode: configuration', () => {
  it('keeps threshold and target inside the model window', () => {
    const c = readConfig({ threshold: 300_000, target: 250_000 });
    expect(limits(c, 200_000)).toEqual({ threshold: 120_000, target: 72_000 });
    expect(limits(c, undefined)).toEqual({ threshold: 300_000, target: 180_000 });
  });

  it('falls back to the defaults on nonsense', () => {
    const c = readConfig({ threshold: -5, language: 'fr', auto: 'yes' });
    expect(c.threshold).toBe(160_000);
    expect(c.language).toBe('en');
    expect(c.auto).toBe(true);
  });
});
