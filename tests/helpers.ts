import type { Message } from '../plugin/src/prune.ts';

let counter = 0;

export function user(text: string): Message {
  return { role: 'user', text, toolUses: [], handle: 'h' };
}

export function assistant(text: string): Message {
  return { role: 'assistant', text, toolUses: [], handle: 'h' };
}

/** A call and its result, the way Claude Code hands them over: two rows. */
export function call(
  tool: string,
  input: Record<string, unknown>,
  result: string,
  isError = false,
): [Message, Message] {
  counter += 1;
  const id = `toolu_${counter}`;
  return [
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: id, tool, input, text: result, ...(isError ? { isError: true as const } : {}) }],
      handle: 'h',
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: result, isError }], handle: 'h' },
  ];
}

export function long(n: number, line = 'some line of output'): string {
  const lines: string[] = [];
  let total = 0;
  let i = 0;
  while (total < n) {
    const l = `${line} ${i++}`;
    lines.push(l);
    total += l.length + 1;
  }
  return lines.join('\n').slice(0, n);
}

/** Old calls to push everything before them out of the recent zone. */
export function filler(count: number, size = 20_000): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i++) out.push(...call('Bash', { command: `ls ${i}` }, long(size)));
  return out;
}

/** A conversation with many old calls and a recent tail. */
export function conversation(old: number, size = 20_000): Message[] {
  const messages: Message[] = [user('Fix the failing test. Never touch src/generated.')];
  for (let i = 0; i < old; i++) {
    messages.push(assistant(`Looking at file ${i}.`));
    messages.push(...call('Bash', { command: `cat file${i}.txt` }, long(size)));
  }
  messages.push(user('Now run the tests again.'));
  messages.push(...call('Bash', { command: 'npm test' }, long(5_000, 'test ok')));
  messages.push(assistant('All tests pass.'));
  return messages;
}

export function idOf(row: Message): string {
  return row.toolUses[0]?.tool_use_id ?? row.toolResults?.[0]?.tool_use_id ?? '';
}
