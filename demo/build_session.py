#!/usr/bin/env python3
"""Build a realistic Claude Code session for the demo recordings.

Every tool result in the session comes from really running the command, or
really reading the file, in a throwaway clone of expressjs/express (MIT). Only
the prompts and the assistant's prose are scripted. Nothing personal goes in.

    # on a fresh clone: the script edits a test and commits it
    git clone --depth 1 https://github.com/expressjs/express /tmp/lopper-demo/express
    (cd /tmp/lopper-demo/express && npm install)
    python3 demo/build_session.py /tmp/lopper-demo/express

It writes ~/.claude/projects/<cwd slug>/<session id>.jsonl and prints the id,
ready for `claude --resume <id>`.
"""
import datetime
import json
import os
import random
import re
import subprocess
import sys
import uuid

CWD = os.path.realpath(sys.argv[1])
SID = sys.argv[2] if len(sys.argv) > 2 else str(uuid.uuid4())
VERSION = '2.1.283'
MODEL = 'claude-opus-5-5'
BASH_LIMIT = 30_000  # Claude Code spills bigger outputs to a file and shows a preview
MOCHA = 'npx mocha --require test/support/env --check-leaks'

random.seed(7)
records = []
parent = None
clock = datetime.datetime(2026, 9, 25, 19, 2, 11, tzinfo=datetime.timezone.utc)
seen_chars = 0


def tick(lo=2, hi=14):
    global clock
    clock += datetime.timedelta(seconds=random.uniform(lo, hi))
    return clock.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def base(kind):
    global parent
    rec = {
        'parentUuid': parent,
        'isSidechain': False,
        'userType': 'external',
        'entrypoint': 'cli',
        'cwd': CWD,
        'sessionId': SID,
        'version': VERSION,
        'gitBranch': 'master',
        'type': kind,
        'uuid': str(uuid.uuid4()),
        'timestamp': tick(),
    }
    parent = rec['uuid']
    return rec


def usage():
    # What the status line and `/context` read: the context of the last request.
    # Calibrated on a real resume of this session: 277k tokens for 667k characters.
    context = 10_000 + seen_chars * 2 // 5
    return {
        'input_tokens': 3,
        'cache_creation_input_tokens': random.randint(800, 4_000),
        'cache_read_input_tokens': context,
        'output_tokens': random.randint(120, 900),
        'service_tier': 'standard',
    }


def count(text):
    global seen_chars
    seen_chars += len(text)


def user(text):
    count(text)
    rec = base('user')
    rec['message'] = {'role': 'user', 'content': text}
    records.append(rec)


def assistant(*blocks):
    """One API response: Claude Code stores one record per content block."""
    message_id = 'msg_01' + uuid.uuid4().hex[:22]
    for block in blocks:
        rec = base('assistant')
        rec['message'] = {
            'model': MODEL,
            'id': message_id,
            'type': 'message',
            'role': 'assistant',
            'content': [block],
            'stop_reason': 'tool_use' if block['type'] == 'tool_use' else 'end_turn',
            'stop_sequence': None,
            'usage': usage(),
        }
        rec['requestId'] = 'req_01' + uuid.uuid4().hex[:22]
        records.append(rec)
        if block['type'] == 'text':
            count(block['text'])


def say(text):
    assistant({'type': 'text', 'text': text})


def tool(name, tool_input, result, record, is_error=False, preface=None):
    count(json.dumps(tool_input))
    count(result)
    tool_id = 'toolu_01' + uuid.uuid4().hex[:22]
    blocks = [{'type': 'text', 'text': preface}] if preface else []
    blocks.append({'type': 'tool_use', 'id': tool_id, 'name': name, 'input': tool_input})
    assistant(*blocks)
    source = parent
    rec = base('user')
    content = {'tool_use_id': tool_id, 'type': 'tool_result', 'content': result}
    if is_error:
        content['is_error'] = True
    rec['message'] = {'role': 'user', 'content': [content]}
    rec['toolUseResult'] = record
    rec['sourceToolAssistantUUID'] = source
    records.append(rec)


def bash(command, description, preface=None):
    done = subprocess.run(command, shell=True, cwd=CWD, capture_output=True, text=True,
                          env={**os.environ, 'NO_COLOR': '1', 'FORCE_COLOR': '0'})
    out = (done.stdout + done.stderr).rstrip('\n')
    out = re.sub(r'\x1b\[[0-9;]*m', '', out)
    shown = out
    if len(out) > BASH_LIMIT:
        shown = (f'Output too large ({len(out) / 1024:.1f}KB). Full output saved to: '
                 f'/tmp/claude-501/{SID}/tool-results/{uuid.uuid4().hex[:8]}.txt\n\n'
                 f'Preview (first 2KB):\n{out[:2000]}\n...')
    tool('Bash', {'command': command, 'description': description}, shown,
         {'stdout': done.stdout, 'stderr': done.stderr, 'interrupted': False, 'isImage': False},
         is_error=done.returncode != 0, preface=preface)
    return out


def read(path, preface=None):
    full = os.path.join(CWD, path)
    with open(full, encoding='utf-8') as fh:
        lines = fh.read().split('\n')
    numbered = '\n'.join(f'{i + 1:>6}\t{line}' for i, line in enumerate(lines[:2000]))
    tool('Read', {'file_path': full}, numbered,
         {'type': 'text', 'file': {'filePath': full, 'content': '\n'.join(lines),
                                   'numLines': len(lines), 'startLine': 1, 'totalLines': len(lines)}},
         preface=preface)


def edit(path, old, new, preface=None):
    full = os.path.join(CWD, path)
    with open(full, encoding='utf-8') as fh:
        text = fh.read()
    assert text.count(old) == 1, f'edit target not unique in {path}'
    with open(full, 'w', encoding='utf-8') as fh:
        fh.write(text.replace(old, new))
    tool('Edit', {'file_path': full, 'old_string': old, 'new_string': new, 'replace_all': False},
         f'The file {full} has been updated successfully.',
         {'filePath': full, 'oldString': old, 'newString': new, 'replaceAll': False},
         preface=preface)


def slowest(outputs, n=3):
    """The slowest tests in mocha spec output: [(ms, name)]."""
    found = []
    for out in outputs:
        for line in out.split('\n'):
            m = re.search(r'✔ (.+?) \((\d+)ms\)\s*$', line)
            if m:
                found.append((int(m.group(2)), m.group(1).strip()))
    best = {}
    for ms, name in found:
        best[name] = max(ms, best.get(name, 0))
    return sorted(((ms, name) for name, ms in best.items()), reverse=True)[:n]


def passing(out):
    m = re.search(r'(\d+) passing', out)
    return int(m.group(1)) if m else None


def listing(tests):
    return '; '.join(f'"{name}" ({ms} ms)' for ms, name in tests)


# ---------------------------------------------------------------- the session

user("I'm going to spend the evening on Express. Two rules for this whole session: "
     "1) never touch anything in lib/ without a failing test first, and 2) keep every "
     "commit message under 50 characters. Start by getting oriented.")
say('Got it: failing test before any change in lib/, and commit messages under 50 characters. '
    "I'll look around first.")
bash('git log --oneline -12', 'Recent history')
bash('ls lib test test/acceptance', 'Layout of lib and tests')
read('package.json')
for name in ('express', 'application', 'request', 'response', 'utils', 'view'):
    read(f'lib/{name}.js')
say("Express 5 keeps the core small: `lib/application.js` is the app, `request.js` and "
    "`response.js` extend Node's objects, and routing lives in the external `router` package. "
    "The ETag logic is in `res.send()` (lib/response.js, lines 161-192) and the ETag generators "
    "in `lib/utils.js`. Let me get a baseline from the test suite.")
baseline = bash('npm test -- --reporter dot 2>&1 | tail -25', 'Full test suite, dot reporter')
say(f'Baseline is green: {passing(baseline)} passing. The suite takes a few seconds, so running '
    'it often is cheap.')

user('The last commit fixed ETag generation with Transfer-Encoding in res.send. '
     'Read the ETag tests and tell me what is actually covered.')
bash("git log -1 --format='%h %an%n%s%n%n%b'", 'Last commit')
bash('grep -rn "etag\\|ETag" lib/', 'ETag in lib')
read('lib/response.js', preface='Re-reading `res.send()` with the commit in mind.')
read('test/res.send.js')
bash('grep -rn "Transfer-Encoding" test/', 'Transfer-Encoding in tests')
say('The commit makes `res.send()` add Content-Length only when there is no Transfer-Encoding '
    'header (lib/response.js:180-182), and its test ("should still generate an ETag") covers a '
    'string body only. A Buffer body goes through the object branch of `res.send()` and nothing '
    'checks its ETag when the response is chunked. That is the gap.')

user('Add a test for exactly that: a Buffer body with Transfer-Encoding: chunked and etag enabled. '
     'Remember rule 1.')
anchor = "      it('should send ETag for long response', function (done) {"
first = """      it('should send ETag with Transfer-Encoding: chunked', function (done) {
        var app = express();

        app.use(function (req, res) {
          res.set('Transfer-Encoding', 'chunked');
          res.send(Buffer.alloc(999, '-'));
        });

        app.enable('etag');

        request(app)
        .get('/')
        .expect('ETag', '"3e7-qPnkJ3CVdVhFJQvUBfF10TmVA7g"')
        .expect(200, done);
      });

"""
edit('test/res.send.js', anchor, first + anchor, preface='Test first, as agreed.')
bash(f'{MOCHA} test/res.send.js', 'Run the res.send tests')
say('It fails, and usefully: Express sends a weak ETag (`W/"3e7-..."`) and my expectation was a '
    'strong one. The behaviour is right, the test was wrong, so lib/ stays untouched.')
edit('test/res.send.js', """        .expect('ETag', '"3e7-qPnkJ3CVdVhFJQvUBfF10TmVA7g"')
        .expect(200, done);
      });

      it('should send ETag for long response'""", """        .expect('ETag', 'W/"3e7-qPnkJ3CVdVhFJQvUBfF10TmVA7g"')
        .expect(200, done);
      });

      it('should send ETag for long response'""")
bash(f'{MOCHA} test/res.send.js', 'Run the res.send tests again')
bash('git add test/res.send.js && git commit -m "test: etag with chunked transfer" && git log --oneline -1',
     'Commit the test')
say('Passing, and committed as `test: etag with chunked transfer` (32 characters).')

user("Now go through the router and static middleware tests. I want a list of anything slow "
     "or flaky.")
for name in ('app.router', 'Router', 'express.static', 'app.route', 'app.use'):
    read(f'test/{name}.js')
first = [bash(f'{MOCHA} --reporter spec --slow 20 test/{name}.js', f'Run {name} tests')
         for name in ('app.router', 'express.static')]
second = [bash(f'{MOCHA} --reporter spec --slow 20 test/{name}.js', f'Run {name} tests', preface=
               'Running them a second time to spot flakiness.' if name == 'app.router' else None)
          for name in ('app.router', 'express.static')]
same = [passing(a) == passing(b) for a, b in zip(first, second)]
say(('Nothing flaky: ' if all(same) else 'Something is off: ')
    + f'app.router passed {passing(first[0])} then {passing(second[0])}, express.static '
    f'{passing(first[1])} then {passing(second[1])}. Slowest in these runs: '
    f'{listing(slowest(first + second))}.')

user('Same for the body parsers: json, urlencoded, text and raw.')
for name in ('json', 'urlencoded', 'text', 'raw'):
    read(f'test/express.{name}.js')
parsers = bash(f'{MOCHA} --reporter spec --slow 20 test/express.json.js test/express.urlencoded.js '
              'test/express.text.js test/express.raw.js', 'Run the body parser tests')
say(f'All four parsers pass: {passing(parsers)} tests. Slowest: {listing(slowest([parsers]))}.')

user('Last pass: audit the request and response helpers, every req.* and res.* test file.')
helpers = sorted(f for f in os.listdir(os.path.join(CWD, 'test'))
                 if re.match(r'(req|res)\..+\.js$', f))
for name in helpers:
    read(f'test/{name}')
runs = [bash(f'{MOCHA} --reporter spec test/{group}', f'Run the {group[:3]} helper tests')
        for group in ('res.*.js', 'req.*.js')]
counts = {}
for name in helpers:
    with open(os.path.join(CWD, 'test', name), encoding='utf-8') as fh:
        counts[name] = len(re.findall(r'\bit\(', fh.read()))
thin = sorted(counts.items(), key=lambda kv: kv[1])[:2]
say(f'Read all {len(helpers)} helper test files and ran them: {passing(runs[0])} response tests and '
    f'{passing(runs[1])} request tests, all passing. The thinnest files are '
    + ' and '.join(f'`{name}` ({n} test{"" if n == 1 else "s"})' for name, n in thin) + '.')

user('Run the whole suite once more and give me the final picture.')
final = bash('npm test -- --reporter dot 2>&1 | tail -25', 'Full test suite, dot reporter')
say(f'Final picture: {passing(final)} passing, one more than the baseline of {passing(baseline)}: '
    'the new test for the chunked ETag case, committed. Nothing changed in lib/.')

slug = re.sub(r'[^A-Za-z0-9]', '-', CWD)
folder = os.path.expanduser(f'~/.claude/projects/{slug}')
os.makedirs(folder, exist_ok=True)
path = os.path.join(folder, f'{SID}.jsonl')
with open(path, 'w', encoding='utf-8') as fh:
    for rec in records:
        fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
print(SID)
print(f'{path}: {len(records)} records, ~{seen_chars // 1000}k characters, '
      f'~{(10_000 + seen_chars * 2 // 5) // 1000}k tokens', file=sys.stderr)
