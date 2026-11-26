/** Smoke test for the OpenFilm MagicShow/MagicThinking overlay (fork build). */
import { chromium } from 'playwright-core';
import TS from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const desktop = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const magicDir = path.join(desktop, 'shell', 'magic');
const ts = fs.readFileSync(path.join(magicDir, 'magic-overlay.ts'), 'utf8')
  .replace("import './animation.cjs';", '')
  .replace('export function mountMagicOverlay', 'function mountMagicOverlay');
const js = TS.transpileModule(ts, { compilerOptions: { module: TS.ModuleKind.None, target: TS.ScriptTarget.ES2022 } }).outputText;

const browser = await chromium.launch({
  executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
// Mirror the real shell: #root is a zero-height React mount; the chat column
// occupies the LEFT ~420px and Studio is to its right. The old port measured
// from #root and put `library` inside the chat, so import/command cursors
// danced in the chat instead of over the timeline.
await page.setContent(`<style>html,body{margin:0;height:100%;background:#111}#root{position:absolute;left:420px;top:0;width:780px;height:0}#of-chat{position:absolute;left:0;top:0;width:420px;height:800px}#of-chat .composer{position:absolute;left:60px;top:748px;width:300px;height:22px}</style>
  <div id="root"></div><div id="of-chat"><div class="composer" contenteditable="true"></div></div>`);
await page.addScriptTag({ path: path.join(magicDir, 'animation.cjs') });
await page.addScriptTag({ content: js });

const fire = (detail) => page.evaluate((d) => window.dispatchEvent(new CustomEvent('openfilm:magic', { detail: d })), detail);
const painted = () => page.evaluate(() => {
  const c = document.getElementById('of-magic-canvas');
  if (!c) return -1;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
  return n;
});
const CHAT_RIGHT = 420;
await page.evaluate(() => {
  const A = window.OpenFilmMagicAnimation;
  window.__poses = [];
  const orig = A.agentPose;
  A.agentPose = function (...args) {
    const r = orig.apply(this, args);
    if (r && !r.hidden && r.pos) window.__poses.push({ x: r.pos.x, y: r.pos.y });
    return r;
  };
});

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

// 1) MagicThinking — the full-window dimming + scan brackets + stage badge.
await fire({ type: 'agent-thinking' });
await page.waitForTimeout(600);
const thinkingPixels = await painted();
check('thinking layer painted', thinkingPixels > 1000, thinkingPixels + ' px');
await fire({ type: 'agent-thinking', done: true });
await page.waitForTimeout(1500);

// 2) MagicShow on its own. Regression: agentPose used to read S.spawn (undefined)
//    and threw "Cannot read properties of undefined (reading 'x')", killing the
//    frame loop while thinking's dimming masked the failure.
await fire({ type: 'agent-act', callId: 'c1', act: 'film.arrange', query: 'cut the shots' });
await fire({ type: 'agent-act', callId: 'c2', act: 'audio.music', query: 'add music' });
let peak = 0;
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(150);
  const n = await painted();
  if (n > peak) peak = n;
}
check('swarm cursors painted', peak > 100 && peak < 200000, peak + ' px');

// 3) Reading / shell / research acts are THINKING, not edits. The screenshots
//    showed cursors "making" over the timeline while the agent only read files.
//    They must NOT dispatch any editing cursor, only keep the thinking layer.
await fire({ type: 'agent-thinking', done: true });
await page.waitForTimeout(1400);
await page.evaluate(() => {
  window.__poses = [];
  for (const act of ['command.run', 'files.read', 'research.read', 'film.check', 'working']) {
    window.dispatchEvent(new CustomEvent('openfilm:magic', { detail: { type: 'agent-act', callId: 'think-' + act, act, query: 'read' } }));
  }
});
await page.waitForTimeout(1200);
const thinkingPoses = await page.evaluate(() => window.__poses.length);
check('thinking acts spawn no editing cursors', thinkingPoses === 0, thinkingPoses + ' cursor poses');

// 4) Real edits (film.arrange / scene.*) DO send cursors — and to the timeline.
await fire({ type: 'agent-thinking', done: true });
await page.waitForTimeout(1400);
await page.evaluate(() => {
  window.__poses = [];
  for (let i = 0; i < 6; i++) {
    window.dispatchEvent(new CustomEvent('openfilm:magic', { detail: { type: 'agent-act', callId: 'edit' + i, act: 'film.arrange', query: 'cut' } }));
  }
});
await page.waitForTimeout(1200);
const landing = await page.evaluate((chatRight) => {
  const ps = window.__poses;
  return { n: ps.length, inChat: ps.filter((q) => q.x < chatRight).length, inStudio: ps.filter((q) => q.x >= chatRight).length };
}, CHAT_RIGHT);
check('edit cursors fly to Studio timeline, not chat', landing.n > 0 && landing.inStudio > landing.inChat,
  `${landing.inStudio}/${landing.n} in studio, ${landing.inChat} in chat`);
check('no page errors', errors.length === 0, errors.join(' | ') || 'none');


await browser.close();
process.exit(checks.every((c) => c.ok) ? 0 : 1);
