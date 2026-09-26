#!/usr/bin/env python3
"""Record a real terminal session to an asciicast v2 file, driven by a script.

The program runs in a pseudo-terminal of a fixed size; every byte it prints is
kept with its timestamp. Nothing is re-rendered or faked: agg turns the cast into
a GIF afterwards (`agg --font-size 18 demo.cast demo.gif`).

    python3 demo/record.py out.cast script.json -- claude --resume <id>

The script is a JSON list of steps:
    {"wait": "text", "timeout": 60}    wait until the screen shows text
      "optional": true, "then": ["down", "enter"]   skip if it never shows; keys to press if it does
    {"sleep": 1.5}                     just wait
    {"type": "/compact", "cps": 18}    type like a person
    {"key": "enter"}                   enter, esc, down, up, tab, ctrl-c
    {"mark": true}                     the recording starts here: what came
                                       before is folded into the first frame
    {"watch": "text", "keys": ["esc"]} whenever text shows up (a pop-up), press keys
"""
import json
import os
import pty
import re
import select
import signal
import sys
import time

KEYS = {'enter': b'\r', 'esc': b'\x1b', 'down': b'\x1b[B', 'up': b'\x1b[A', 'tab': b'\t',
        'ctrl-c': b'\x03', 'ctrl-l': b'\x0c'}
ANSI = re.compile(rb'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]')


def main():
    cast_path, script_path = sys.argv[1], sys.argv[2]
    command = sys.argv[sys.argv.index('--') + 1:]
    cols = int(os.environ.get('COLS', '110'))
    rows = int(os.environ.get('ROWS', '32'))
    with open(script_path, encoding='utf-8') as fh:
        steps = json.load(fh)

    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ, TERM='xterm-256color', COLUMNS=str(cols), LINES=str(rows))
        os.execvpe(command[0], command, env)
    import fcntl
    import struct
    import termios
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    start = time.monotonic()
    marked_at = None
    events = []
    screen = b''
    watches = [(re.sub(r'\s+', '', w['watch']), [KEYS[k] for k in w['keys']]) for w in steps if 'watch' in w]
    watch_tail = b''

    def pump(seconds):
        nonlocal screen
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if not ready:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            events.append((time.monotonic() - start, data))
            screen = (screen + data)[-200_000:]
            fresh = re.sub(r'\s+', '', ANSI.sub(b'', data).decode('utf-8', 'replace'))
            for text, keys in watches:
                if text in fresh:
                    for key in keys:
                        os.write(fd, key)
        return True

    def visible():
        return ANSI.sub(b'', screen).decode('utf-8', 'replace')

    def squeezed(text):
        # The TUI draws spaces by moving the cursor: compare without whitespace.
        return re.sub(r'\s+', '', text)

    for step in steps:
        if 'watch' in step:
            continue
        if 'wait' in step:
            deadline = time.monotonic() + step.get('timeout', 60)
            found = True
            while squeezed(step['wait']) not in squeezed(visible()):
                if time.monotonic() > deadline:
                    if step.get('optional'):
                        found = False
                        break
                    sys.stderr.write(visible()[-2500:] + '\n')
                    sys.exit(f"timed out waiting for {step['wait']!r}")
                if not pump(0.2):
                    sys.exit('the program exited')
            if not found:
                continue
            for key in step.get('then', []):
                os.write(fd, KEYS[key])
                pump(0.4)
            if step.get('reset', True):
                screen = b''
        elif 'sleep' in step:
            pump(step['sleep'])
        elif 'type' in step:
            delay = 1 / step.get('cps', 16)
            for ch in step['type']:
                os.write(fd, ch.encode('utf-8'))
                pump(delay)
        elif 'key' in step:
            os.write(fd, KEYS[step['key']])
            pump(0.1)
        elif step.get('mark'):
            marked_at = time.monotonic() - start
    pump(0.5)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

    origin = marked_at or 0.0
    # Decode as one stream: a multi-byte character can straddle two reads.
    import codecs
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    with open(cast_path, 'w', encoding='utf-8') as out:
        out.write(json.dumps({'version': 2, 'width': cols, 'height': rows,
                              'env': {'TERM': 'xterm-256color', 'SHELL': '/bin/zsh'}}) + '\n')
        for moment, data in events:
            text = decoder.decode(data)
            if text:
                out.write(json.dumps([round(max(0.0, moment - origin), 3), 'o', text]) + '\n')
    print(f'{cast_path}: {len(events)} events, {events[-1][0] - origin:.1f} s after the mark')


if __name__ == '__main__':
    main()
