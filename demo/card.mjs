#!/usr/bin/env node
// Draws media/card.png (1280×640), the social preview for GitHub and X.
import { homedir } from 'node:os';
import { chromium } from 'playwright-core';

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:1280px;height:640px;background:radial-gradient(120% 90% at 85% -10%,#18283a 0%,#0b0e14 58%);
       color:#e6e9ef;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;overflow:hidden}
  .wrap{padding:78px 88px;display:flex;flex-direction:column;height:100%;box-sizing:border-box}
  .kicker{font:600 20px/1 "SF Mono",Menlo,monospace;letter-spacing:.2em;text-transform:uppercase;color:#8fa3b8}
  h1{margin:22px 0 0;font:800 128px/1 "SF Mono",Menlo,monospace;letter-spacing:-.02em}
  h1 span{color:#3ddc97}
  p{margin:26px 0 0;font-size:36px;line-height:1.3;color:#c9d1dc;max-width:980px}
  .row{margin-top:auto;display:flex;gap:18px}
  .pill{padding:16px 22px;border:1px solid #2a3544;border-radius:14px;background:#121821;font:600 26px/1 "SF Mono",Menlo,monospace}
  .pill b{color:#3ddc97;font-weight:700}
</style></head><body><div class="wrap">
  <div class="kicker">Claude Code plugin</div>
  <h1>lopper<span>.</span></h1>
  <p>Compaction that prunes old tool output instead of summarizing. Every word you and Claude wrote stays.</p>
  <div class="row">
    <div class="pill"><b>281k → 73k</b> tokens</div>
    <div class="pill"><b>&lt; 0.1 s</b> vs 26 s</div>
    <div class="pill">local · no API key · MIT</div>
  </div>
</div></body></html>`;

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ??
    `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-x64/chrome-headless-shell`,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.setContent(html);
await page.screenshot({ path: new URL('../media/card.png', import.meta.url).pathname });
await browser.close();
console.log('media/card.png');
