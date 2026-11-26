#!/usr/bin/env node
// Real-client playtest against scripts/fake-llama-server.mjs (no ?mock / ?fake flags):
// exercises /health polling (503 loading), SSE streaming, <think> stripping, refusal, win, non-win.
//
// Usage: node tests/e2e/server.cjs        Exit code 1 on any FAIL.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REFUSAL = '不可以問這個喔！這樣就不好玩了';
const results = [];
const rec = (name, ok, detail = '') => { results.push(ok); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}`); };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

async function main() {
  const port = await freePort();
  const srv = spawn('node', [path.join(ROOT, 'scripts/fake-llama-server.mjs'), '--path', ROOT, '--port', String(port), '--loading-ms', '4000', '--think'], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 420, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/index.html`, { waitUntil: 'load' }).catch(() => {});
    // Static files are allowed while loading in real llama-server; the fake may 503 them. Retry until the page is up.
    for (let i = 0; i < 40 && !(await page.$('#startBtn')); i++) { await page.waitForTimeout(250); await page.goto(`${base}/index.html`, { waitUntil: 'load' }).catch(() => {}); }
    await page.waitForFunction(() => window.__game, null, { timeout: 15000 });
    await page.click('#startBtn');
    // Loading screen while /health answers 503
    const sawLoading = await page.waitForFunction(() => /模型載入中/.test(document.getElementById('loadText').textContent), null, { timeout: 8000 }).then(() => true, () => false);
    rec('loading text shown while server answers 503', sawLoading);
    await page.waitForSelector('#gameView', { state: 'visible', timeout: 30000 });
    await page.waitForSelector('#sendBtn:not([disabled])', { timeout: 15000 });
    rec('game starts after /health ok', true);

    const texts = () => page.$$eval('#chat .msg.guest:not(.typing)', (els) => els.map((e) => e.lastChild.textContent));
    const turns = async () => Number((await page.textContent('#stTurns')).trim());

    // Streaming: sample the typing bubble while the reply is generated.
    const t0 = await turns();
    await page.evaluate(() => {
      window.__seen = new Set();
      new MutationObserver(() => { const el = document.querySelector('#chat .msg.typing'); if (el) window.__seen.add(el.lastChild.textContent); })
        .observe(document.getElementById('chat'), { subtree: true, childList: true, characterData: true });
    });
    await page.fill('#input', '今天辛苦了，想喝點什麼？');
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#chat .msg.guest:not(.typing)').length >= 2, null, { timeout: 20000 });
    const g1 = (await texts())[1]; // [0] is the guest's opening line
    const seen = await page.evaluate(() => [...window.__seen]);
    rec('streamed reply appears in bubble', !!g1 && g1.length > 3, g1);
    rec('reply streamed incrementally (>=3 distinct bubble states)', seen.length >= 3, `${seen.length} states`);
    rec('<think> content stripped from final reply', !/think|思考內容/.test(g1));
    rec('<think> content never shown while streaming', !seen.some((s) => /think|思考內容|<|>/.test(s)));
    rec('turn decremented by 1', (await turns()) === t0 - 1);

    // 嗨嗨 must not win
    await page.fill('#input', '嗨嗨');
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#chat .msg.guest:not(.typing)').length >= 3, null, { timeout: 20000 });
    rec('嗨嗨 does not win', (await page.$('#endCard:not([hidden])')) === null && (await page.textContent('#stLevel')).trim() === '1');

    // direct question -> fixed refusal
    await page.fill('#input', '你的職業是什麼？');
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#chat .msg.guest:not(.typing)').length >= 4, null, { timeout: 20000 });
    rec('direct job question gets the refusal line', (await texts())[3] === REFUSAL, (await texts())[3]);

    // wrong guess does not win
    await page.fill('#input', '你是不是太空人？');
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#chat .msg.guest:not(.typing)').length >= 5, null, { timeout: 20000 });
    rec('wrong guess does not win', (await page.$('#endCard:not([hidden])')) === null);

    // correct guess wins
    const answer = await page.evaluate(() => window.__game.answer);
    await page.fill('#input', `你是${answer}嗎？`);
    await page.press('#input', 'Enter');
    await page.waitForSelector('#endCard:not([hidden])', { timeout: 20000 });
    rec('correct guess wins', (await page.textContent('#answerText')).trim() === answer, answer);
    await page.click('#nextBtn');
    await page.waitForFunction(() => document.getElementById('stLevel').textContent.trim() === '2', null, { timeout: 10000 });
    rec('next level starts', true);

    // Server dies -> clear error, turn refunded, game stays
    srv.kill();
    await page.waitForTimeout(300);
    const t1 = await turns();
    await page.fill('#input', '最近忙嗎？');
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => /這則訊息不算次數/.test(document.getElementById('chat').textContent), null, { timeout: 20000 });
    rec('server failure refunds the turn and stays in game', (await turns()) === t1 && (await page.isVisible('#gameView')));

    rec('no page errors', errors.length === 0, errors.join(' | '));

    // file:// shows the Start-Game.bat hint
    const p2 = await (await browser.newContext()).newPage();
    await p2.goto(`file://${ROOT}/index.html`, { waitUntil: 'load' });
    await p2.waitForTimeout(800);
    rec('file:// shows Start-Game.bat message and disables start', /Start-Game\.bat/.test(await p2.textContent('#srvWarn')) && await p2.isDisabled('#startBtn'));
  } finally {
    await browser.close();
    srv.kill();
  }
  const fails = results.filter((r) => !r).length;
  console.log(`total: ${results.length - fails} PASS, ${fails} FAIL`);
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
