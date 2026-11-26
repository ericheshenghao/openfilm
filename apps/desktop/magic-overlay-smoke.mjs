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
await page.setContent(`<style>html,body{margin:0;height:100%;background:#111}#root{position:absolute;left:0;top:0;width:900px;height:800px}#of-chat{position:absolute;left:900px;top:0;width:300px;height:800px}</style>
  <div id="root"></div><div id="of-chat"></div>`);
await page.addScriptTag({ path: path.join(magicDir, 'animation.cjs') });
await page.addScriptTag({ content: js });
await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent('openfilm:magic', { detail: { type: 'agent-thinking' } }));
  window.dispatchEvent(new CustomEvent('openfilm:magic', { detail: { type: 'agent-act', callId: 'c1', act: 'film.arrange', query: 'cut the shots' } }));
  window.dispatchEvent(new CustomEvent('openfilm:magic', { detail: { type: 'agent-act', callId: 'c2', act: 'audio.music', query: 'add music' } }));
});
await page.waitForTimeout(600);
const result = await page.evaluate(() => {
  const c = document.getElementById('of-magic-canvas');
  if (!c) return { canvas: false, painted: 0 };
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let painted = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
  return { canvas: true, painted, w: c.width, h: c.height };
});
console.log(result.canvas && result.painted > 1000 ? 'PASS magic overlay painted ' + result.painted + ' pixels' : 'FAIL ' + JSON.stringify(result));
await browser.close();
process.exit(result.canvas && result.painted > 1000 ? 0 : 1);
