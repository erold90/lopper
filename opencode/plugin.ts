// The file opencode loads. opencode 2 reads the default export's `id` and `setup`;
// opencode 1 (1.18.29 and later) calls its `server`.
import { configFile, dataDir, fileStore, LopperPlugin, readConfig } from './lopper.ts';
import { engine, type Msg } from './v2.ts';

/** The parts of opencode 2's plugin context lopper uses. */
interface Context {
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<{ type: string; data?: Record<string, unknown> }>;
  };
  model: {
    list(): Promise<unknown>;
  };
  session: {
    hook(
      name: 'context' | 'compaction',
      callback: (event: {
        sessionID: string;
        model: { providerID: string; id: string };
        system: { text?: string }[];
        messages: Msg[];
        tools?: Record<string, unknown>;
      }) => Promise<void> | void,
    ): Promise<unknown>;
  };
}

interface Tokens {
  input?: number;
  output?: number;
  cache?: { read?: number; write?: number };
}

async function setup(ctx: Context): Promise<() => void> {
  const c = readConfig(configFile());
  const e = engine(c, fileStore(dataDir()));
  // The real size of each session's last call, as the provider reported it.
  const context = new Map<string, number>();
  const windows = new Map<string, number | undefined>();

  const windowOf = async (providerID: string, id: string): Promise<number | undefined> => {
    const key = `${providerID}/${id}`;
    if (windows.has(key)) return windows.get(key);
    let window: number | undefined;
    try {
      const raw = (await ctx.model.list()) as unknown;
      const list = (Array.isArray(raw) ? raw : ((raw as { data?: unknown })?.data ?? [])) as {
        providerID?: string;
        id?: string;
        modelID?: string;
        limit?: { context?: number };
      }[];
      const m = list.find((x) => x.providerID === providerID && (x.id === id || x.modelID === id));
      window = m?.limit?.context;
    } catch {}
    windows.set(key, window);
    return window;
  };

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
        const sessionID = ev.data?.['sessionID'];
        if (typeof sessionID !== 'string') continue;
        if (ev.type === 'session.step.ended') {
          const t = ev.data?.['tokens'] as Tokens | undefined;
          if (t) context.set(sessionID, (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0));
        } else if (ev.type === 'session.compaction.ended' || ev.type === 'session.deleted') {
          context.delete(sessionID);
          e.reset(sessionID);
        }
      }
    } catch {
      // The stream ends on cleanup; without it lopper estimates the size from the messages.
    }
  })();

  const fixedChars = (ev: { system: { text?: string }[]; tools?: Record<string, unknown> }): number => {
    let n = ev.system.reduce((sum, p) => sum + String(p.text ?? '').length, 0);
    try {
      n += JSON.stringify(ev.tools ?? {}).length;
    } catch {}
    return n;
  };

  await ctx.session.hook('context', async (ev) => {
    try {
      e.transform({
        sessionID: ev.sessionID,
        messages: ev.messages,
        context: context.get(ev.sessionID),
        fixedChars: fixedChars(ev),
        window: await windowOf(ev.model.providerID, ev.model.id),
      });
    } catch {
      // Never block a call: on any trouble the conversation goes as opencode built it.
    }
  });
  // The conversation opencode summarizes: the same cut, and no new one decided there.
  await ctx.session.hook('compaction', (ev) => {
    try {
      e.transform({ sessionID: ev.sessionID, messages: ev.messages, readOnly: true });
    } catch {}
  });

  return () => controller.abort();
}

export default { id: 'lopper', setup, server: LopperPlugin };
