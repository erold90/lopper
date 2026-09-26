#!/usr/bin/env node
/**
 * Turns an asciicast into an MP4 and a GIF, drawn by xterm.js in headless
 * Chromium: the terminal emulator VS Code uses, so the TUI's cursor moves, box
 * drawing and colours land where they should.
 *
 *   node demo/render.mjs rec.cast media/name --title "claude · with lopper" \
 *        [--speed 12.5-140:10] [--badge "sped up 10×"] [--hold 3] [--fps 15]
 *
 * --speed FROM-TO:FACTOR plays that stretch of the recording FACTOR times faster
 * (repeatable); while it does, the badge shows in the title bar, so a speed-up is
 * never hidden. Output: <name>.mp4 and <name>.gif.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const castPath = resolve(args[0]);
const outBase = resolve(args[1]);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const title = flag('title', 'claude');
const badge = flag('badge', '');
const fps = Number(flag('fps', '15'));
const hold = Number(flag('hold', '3'));
const fontSize = Number(flag('font-size', '15'));
const speeds = args
  .map((a, i) => (a === '--speed' ? args[i + 1] : null))
  .filter(Boolean)
  .map((s) => {
    const [range, factor] = s.split(':');
    const [from, to] = range.split('-').map(Number);
    return { from, to, factor: Number(factor) };
  });

const lines = readFileSync(castPath, 'utf8').trim().split('\n');
const header = JSON.parse(lines[0]);
const events = lines.slice(1).map((l) => JSON.parse(l)).filter((e) => e[1] === 'o');

/** Recording time → video time, with the sped-up stretches compressed. */
function videoTime(t) {
  let out = 0;
  let cursor = 0;
  for (const s of speeds) {
    if (t <= s.from) break;
    out += s.from - cursor;
    const inside = Math.min(t, s.to) - s.from;
    out += inside / s.factor;
    cursor = Math.min(t, s.to);
    if (t <= s.to) return out;
  }
  return out + (t - cursor);
}
const inSpeedUp = (t) => speeds.some((s) => t > s.from && t < s.to);

const timeline = events.map(([t, , data]) => ({ at: videoTime(t), data, sped: inSpeedUp(t) }));
const end = (timeline.at(-1)?.at ?? 0) + hold;

const xtermJs = readFileSync(join(here, '../node_modules/@xterm/xterm/lib/xterm.js'), 'utf8');
const xtermCss = readFileSync(join(here, '../node_modules/@xterm/xterm/css/xterm.css'), 'utf8');

const page_html = `<!doctype html><html><head><meta charset="utf-8"><style>${xtermCss}
  html,body{margin:0;background:#0b0e14}
  #win{display:inline-block;margin:18px;border-radius:12px;overflow:hidden;background:#15181f;
       box-shadow:0 18px 50px -18px #000;border:1px solid #2a2f3a}
  #bar{height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#1c2029;
       border-bottom:1px solid #2a2f3a;font:500 13px -apple-system,system-ui,sans-serif;color:#9aa4b2}
  .dot{width:12px;height:12px;border-radius:50%}
  #title{margin-left:10px;flex:1}
  #badge{display:none;padding:3px 10px;border-radius:999px;background:#e6b34a;color:#1b1400;font-weight:700}
  #term{padding:10px 12px 12px}
  .xterm .scrollbar, .xterm .slider{display:none !important}
</style></head><body><div id="win"><div id="bar">
  <span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span>
  <span class="dot" style="background:#28c840"></span><span id="title"></span><span id="badge"></span></div>
  <div id="term"></div></div>
<script>${xtermJs}</script>
<script>
  const term = new Terminal({
    cols: ${header.width}, rows: ${header.height}, fontSize: ${fontSize}, lineHeight: 1.12,
    fontFamily: 'Menlo, "SF Mono", monospace', cursorBlink: false, allowProposedApi: true,
    theme: { background: '#15181f', foreground: '#e6e9ef', cursor: '#e6e9ef',
      black: '#1c2029', red: '#ff6b6b', green: '#3ddc97', yellow: '#e6b34a', blue: '#4ea1ff',
      magenta: '#c792ea', cyan: '#5fd7ff', white: '#dfe3ea', brightBlack: '#6b7385',
      brightRed: '#ff8787', brightGreen: '#6ff0b5', brightYellow: '#ffd479', brightBlue: '#82c0ff',
      brightMagenta: '#dcb6ff', brightCyan: '#9ae9ff', brightWhite: '#ffffff' },
  });
  term.open(document.getElementById('term'));
  window.feed = (data) => new Promise((ok) => term.write(data, ok));
  window.setTitle = (t) => { document.getElementById('title').textContent = t; };
  window.setBadge = (b) => { const el = document.getElementById('badge');
    el.textContent = b; el.style.display = b ? 'inline-block' : 'none'; };
</script></body></html>`;

const executablePath =
  process.env.CHROME ??
  join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-x64/chrome-headless-shell');
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setContent(page_html);
await page.evaluate((t) => window.setTitle(t), title);
await page.waitForTimeout(300);
const win = page.locator('#win');

const work = mkdtempSync(join(tmpdir(), 'lopper-render-'));
const frames = [];
let next = 0;
let lastPng = null;
let lastBadge = null;
let changed = true;
for (let frame = 0; frame * (1 / fps) <= end; frame++) {
  const t = frame / fps;
  let chunk = '';
  let sped = false;
  while (next < timeline.length && timeline[next].at <= t) {
    chunk += timeline[next].data;
    sped ||= timeline[next].sped;
    next++;
  }
  const b = sped || speeds.some((s) => videoTime(s.from) < t && t < videoTime(s.to)) ? badge : '';
  if (chunk) {
    await page.evaluate((d) => window.feed(d), chunk);
    changed = true;
  }
  if (b !== lastBadge) {
    await page.evaluate((x) => window.setBadge(x), b);
    lastBadge = b;
    changed = true;
  }
  const png = join(work, `f${String(frame).padStart(5, '0')}.png`);
  if (changed || !lastPng) {
    await win.screenshot({ path: png });
    lastPng = png;
    changed = false;
  } else {
    copyFileSync(lastPng, png);
  }
  frames.push(png);
}
await browser.close();

const run = (argv) => {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...argv], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${argv.join(' ')}`);
};
const input = ['-framerate', String(fps), '-i', join(work, 'f%05d.png')];
run([...input, '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', `${outBase}.mp4`]);
run([...input, '-vf', `fps=${Math.min(fps, 12)},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, `${outBase}.gif`]);
writeFileSync(`${outBase}.json`, JSON.stringify({ frames: frames.length, seconds: end, speeds, badge }, null, 1));
rmSync(work, { recursive: true, force: true });
console.log(`${outBase}.mp4 and .gif: ${frames.length} frames, ${end.toFixed(1)} s`);
