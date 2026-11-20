#!/usr/bin/env node
// Adversarial judge test for Random ppl talk (Playwright, real UI events only).
//
// Usage:  node tests/e2e/adversarial.cjs
// Env:    ADVERSARIAL_SHOTS=<dir>  screenshot directory (default: scratchpad below)
//         ADVERSARIAL_PORT=<port>  fixed port for the static server (default: free port)
//
// Regression test for the bug "嗨嗨" was judged a correct guess (win card) when the
// LLM judge hallucinates. The judge is forced in ?fake=1 mode by intercepting the
// module js/fake-engine.js with page.route and rewriting the judge reply:
//   yes  -> {"is_guess":true,"correct":true}   (worst case: 0.5B model always says yes)
//   no   -> {"is_guess":false,"correct":false} (judge never recognises a guess)
// No game code is modified. If the rewrite target is not found the run FAILS (the hook
// is broken), it never silently passes.
//
// Checks per guest (10 turns each):
//   - 4 non-guesses (嗨嗨 always included): no win card, level unchanged, turns -1, guest replies
//   - 2 wrong guesses (other occupation, same-suffix occupation): no win card, turns -1
//   - the correct full job_title: win card with the right answer
// Also checks the judge hook really fired (window.__judgeCalls > 0) in the yes/no runs.
//
// Exit code 1 on any FAIL. Uses preinstalled `playwright`; never runs `playwright install`.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const pathToFileURL = (p) => require('url').pathToFileURL(p).href;

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = process.env.ADVERSARIAL_SHOTS ||
  '/tmp/claude-0/-home-user/ec33b23e-6eb5-5947-a0ee-0bbf21d735b0/scratchpad/adversarial';
fs.mkdirSync(SHOTS, { recursive: true });

const GUESTS_PER_RUN = 5;
const NON_GUESSES = [
  '嗨嗨', '你好', '嗨', '哈哈', '今天好累喔', '來杯啤酒', '謝謝',
  '你住哪裡？', '你有養寵物嗎？', '😀', '？',
];
const FORCED = {
  yes: { is_guess: true, correct: true },
  no: { is_guess: false, correct: false },
};
const JUDGE_RUNS = ['yes', 'no'];
const JUDGE_LINE = /reply = JSON\.stringify\(\{ is_guess: guess, correct: false \}\);/;

const results = [];
function record(scenario, name, ok, detail = '') {
  results.push({ scenario, name, ok: !!ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${scenario} | ${name}${detail ? ` -- ${detail}` : ''}`);
}

// ---------- data (read from disk, judged by the real rules module) ----------
async function loadOccupations() {
  const dir = path.join(ROOT, 'data', 'occupations');
  const occs = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (o && o.job_title) occs.push(o);
  }
  return occs;
}

// Wrong guesses must be NOT a correct guess under the game's own deterministic rule,
// otherwise a "must not win" check would be meaningless.
function pickWrongGuesses(occs, answerOcc, rules, count = 2) {
  const others = occs.filter((o) => o.job_title !== answerOcc.job_title && !rules.deterministicGuess(o.job_title, answerOcc));
  const ans = answerOcc.job_title;
  const sameSuffix = (n) => others.filter((o) => {
    const t = o.job_title;
    return n === 2 ? t.slice(-2) === ans.slice(-2) : t.slice(-1) === ans.slice(-1);
  });
  const out = [];
  const suf = sameSuffix(2).length ? sameSuffix(2) : sameSuffix(1);
  if (suf.length) out.push({ kind: `same-suffix(${suf.length ? suf[0].job_title.slice(-2) : ''})`, text: suf[Math.floor(Math.random() * suf.length)].job_title });
  const pool = others.filter((o) => !out.some((x) => x.text === o.job_title));
  out.push({ kind: 'other', text: pool[Math.floor(Math.random() * pool.length)].job_title });
  return out.slice(0, count);
}

// ---------- static server ----------
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = Number(process.env.ADVERSARIAL_PORT) || (await freePort());
  const proc = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', ROOT], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/index.html`);
      if (r.ok) return { proc, base };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('static server did not start');
}

// ---------- page helpers ----------
const shot = async (page, name) => {
  try { await page.screenshot({ path: path.join(SHOTS, `${name.replace(/[^\w一-鿿-]+/g, '_')}.png`) }); } catch { /* ignore */ }
};

async function openGame(browser, base, judgeMode, harness) {
  const context = await browser.newContext({
    isMobile: true, hasTouch: true, viewport: { width: 375, height: 740 }, deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  // Force the judge verdict (the only non-UI hook used by this test).
  await page.route('**/js/fake-engine.js', async (route) => {
    const resp = await route.fetch();
    let body = await resp.text();
    if (JUDGE_LINE.test(body)) {
      const forced = JSON.stringify(FORCED[judgeMode]);
      body = body.replace(JUDGE_LINE, `window.__judgeCalls = (window.__judgeCalls || 0) + 1; reply = '${forced}';`);
      harness.hookApplied = true;
    }
    await route.fulfill({ status: 200, contentType: 'application/javascript', body, headers: { 'cache-control': 'no-store' } });
  });
  page.on('pageerror', (e) => harness.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') harness.errors.push(`console.error: ${m.text()}`); });
  page.on('requestfailed', (r) => { if (!r.url().endsWith('/favicon.ico')) harness.errors.push(`requestfailed ${r.url()}`); });
  await page.goto(`${base}/index.html?fake=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && !document.getElementById('startBtn').disabled, null, { timeout: 15000 });
  await page.waitForTimeout(150);
  return { context, page };
}

const levelNow = (page) => page.textContent('#stLevel').then((t) => Number(t.trim()));
const turnsNow = (page) => page.textContent('#stTurns').then((t) => Number(t.trim()));
const guestCount = (page) => page.$$eval('#chat .msg.guest:not(.typing)', (els) => els.length);

async function startGame(page) {
  await page.tap('#startBtn');
  await page.waitForSelector('#gameView', { state: 'visible', timeout: 30000 });
  await page.waitForSelector('#sendBtn:not([disabled])', { timeout: 15000 });
}

async function sendText(page, text, viaEnter) {
  await page.tap('#input');
  await page.keyboard.type(text);
  if (viaEnter) await page.keyboard.press('Enter');
  else await page.tap('#sendBtn');
}

// Waits for the outcome of one message: a win/lose card, or a guest reply with input usable again.
async function settle(page, guestsBefore, timeout = 20000) {
  try {
    await page.waitForFunction((n) => {
      const card = document.getElementById('endCard');
      if (!card.hidden) return true;
      const replies = document.querySelectorAll('#chat .msg.guest:not(.typing)').length;
      return replies > n && !document.querySelector('#chat .msg.typing') && !document.getElementById('sendBtn').disabled;
    }, guestsBefore, { timeout });
  } catch {
    return { kind: 'timeout' };
  }
  return page.evaluate(() => {
    const card = document.getElementById('endCard');
    const kind = card.hidden ? 'reply' : (card.classList.contains('win') ? 'win' : 'lose');
    return { kind, answer: document.getElementById('answerText')?.textContent || null };
  });
}

// ---------- one guest ----------
async function playGuest(page, { label, judgeMode, guestIdx, rules, occs, harness, log }) {
  const answer = await page.evaluate(() => window.__game.answer);
  const answerOcc = occs.find((o) => o.job_title === answer);
  if (!answerOcc) { record(label, 'answer found in data/', false, `answer=${answer}`); return 'skip'; }
  const level0 = await levelNow(page);
  let turns = await turnsNow(page);
  const turns0 = turns;
  log.push(`${label}: answer=${answer} level=${level0} turns=${turns}`);

  // Non-guesses: 嗨嗨 always, plus a rotating window over the other ten, so all 11 are covered.
  const rest = NON_GUESSES.slice(1);
  const plan = [NON_GUESSES[0], ...[0, 1, 2].map((k) => rest[(guestIdx * 3 + k) % rest.length])];

  const steps = [
    ...plan.map((text) => ({ kind: 'non-guess', text })),
    ...pickWrongGuesses(occs, answerOcc, rules).map((w) => ({ kind: `wrong guess (${w.kind})`, text: w.text })),
  ];

  log.push(`${label}: non-guesses ${JSON.stringify(plan)} wrong=${JSON.stringify(steps.slice(plan.length).map((s) => s.text))}`);

  let i = 0;
  for (const step of steps) {
    const viaEnter = i % 2 === 1;
    i++;
    const tag = `${label} ${step.kind} ${JSON.stringify(step.text)}`;
    const before = turns;
    const n = await guestCount(page);
    await sendText(page, step.text, viaEnter);
    const out = await settle(page, n);
    turns = await turnsNow(page).catch(() => -1);
    const level = await levelNow(page).catch(() => -1);
    if (out.kind === 'timeout') {
      record(label, `${tag}: got an answer in time`, false, 'no reply within 20s');
      await shot(page, `FAIL-${judgeMode}-${guestIdx}-timeout`);
      return 'stuck';
    }
    const won = out.kind === 'win';
    record(label, `${tag}: no win card`, !won, won ? `WIN CARD shown (answer on card: ${out.answer})` : `outcome=${out.kind}`);
    record(label, `${tag}: level unchanged`, level === level0, `level=${level}`);
    record(label, `${tag}: turns -1`, turns === before - 1, `turns ${before} -> ${turns}`);
    if (!won && out.kind !== 'lose') {
      record(label, `${tag}: guest replies in character`, out.kind === 'reply', `outcome=${out.kind}`);
    }
    if (won) {
      await shot(page, `FAIL-${judgeMode}-${guestIdx}-${step.kind.replace(/\W+/g, '_')}-win`);
      log.push(`${label}: WRONGLY WON on ${tag}`);
      // Keep going so the rest of the run still reports: move to the next guest.
      await page.click('#nextBtn');
      await page.waitForFunction(() => !document.getElementById('sendBtn').disabled, null, { timeout: 15000 }).catch(() => {});
      return 'won-early';
    }
    if (out.kind === 'lose') return 'lost';
    if (step.kind === 'non-guess' && step.text === NON_GUESSES[0] && i === 1) await shot(page, `${judgeMode}-g${guestIdx}-hi-reply`);
  }

  // Correct guess: full job_title, read from the game state for the answer only.
  const beforeWin = turns;
  const n = await guestCount(page);
  await sendText(page, answer, i % 2 === 1);
  const out = await settle(page, n);
  const level = await levelNow(page).catch(() => -1);
  const turnsAfter = await turnsNow(page).catch(() => -1);
  const isWin = out.kind === 'win';
  record(label, `correct guess ${JSON.stringify(answer)} wins`, isWin, `outcome=${out.kind}`);
  if (isWin) {
    record(label, 'win card shows the right answer', out.answer === answer, `card="${out.answer}"`);
    record(label, 'level unchanged until next click', level === level0, `level=${level}`);
    record(label, 'correct guess costs one turn', turnsAfter === beforeWin - 1, `turns ${beforeWin} -> ${turnsAfter}`);
    await shot(page, `${judgeMode}-g${guestIdx}-win`);
    await page.click('#nextBtn');
    await page.waitForFunction((l) => document.getElementById('stLevel').textContent.trim() === String(l), level0 + 1, { timeout: 15000 }).catch(() => {});
    const nextLevel = await levelNow(page).catch(() => -1);
    record(label, 'next click -> next level', nextLevel === level0 + 1, `level=${nextLevel}`);
    await page.waitForSelector('#sendBtn:not([disabled])', { timeout: 15000 }).catch(() => {});
    return 'won';
  }
  await shot(page, `FAIL-${judgeMode}-${guestIdx}-correct`);
  log.push(`${label}: correct guess NOT a win, outcome=${out.kind}`);
  return out.kind;
}

// ---------- one judge mode: open a game and play GUESTS_PER_RUN guests ----------
async function runMode(browser, base, judgeMode, rules, occs, log) {
  const harness = { errors: [], hookApplied: false };
  const { context, page } = await openGame(browser, base, judgeMode, harness);
  try {
    await startGame(page);
    for (let g = 0; g < GUESTS_PER_RUN; g++) {
      const label = `${judgeMode}-judge g${g + 1}`;
      if (g > 0) {
        // Previous guest ended on a card: wait for the next-guest button if present.
        const next = await page.$('#nextBtn:not([disabled])');
        if (next && (await page.evaluate(() => !document.getElementById('endCard').hidden))) {
          await next.click();
        }
        await page.waitForSelector('#sendBtn:not([disabled])', { timeout: 15000 }).catch(() => {});
      }
      await playGuest(page, { label, judgeMode, guestIdx: g, rules, occs, harness, log });
      // Make sure the next guest starts from a usable state even after an early win/loss.
      await page.waitForTimeout(100);
    }
    const judgeCalls = await page.evaluate(() => window.__judgeCalls || 0);
    record(`${judgeMode}-judge`, 'judge hook fired (rewrite applied, judge was called)',
      harness.hookApplied && judgeCalls > 0, `hookApplied=${harness.hookApplied} judgeCalls=${judgeCalls}`);
    record(`${judgeMode}-judge`, 'no page errors / console errors / failed requests',
      harness.errors.length === 0, harness.errors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
  }
}

async function main() {
  const rules = await import(pathToFileURL(path.join(ROOT, 'js', 'rules.js')));
  const occs = await loadOccupations();
  const { proc, base } = await startServer();
  const browser = await chromium.launch();
  const log = [];
  try {
    for (const mode of JUDGE_RUNS) {
      await runMode(browser, base, mode, rules, occs, log);
    }
  } finally {
    await browser.close();
    proc.kill();
  }

  console.log('\n==== NOTES ====');
  for (const l of log) console.log(l);

  const byScenario = new Map();
  for (const r of results) {
    const s = byScenario.get(r.scenario) || { pass: 0, fail: 0 };
    r.ok ? s.pass++ : s.fail++;
    byScenario.set(r.scenario, s);
  }
  console.log('\n==== SUMMARY (adversarial) ====');
  console.log('scenario'.padEnd(20), 'pass', 'fail');
  for (const [k, v] of byScenario) console.log(k.padEnd(20), String(v.pass).padStart(4), String(v.fail).padStart(4));
  const failed = results.filter((r) => !r.ok);
  console.log(`total: ${results.length - failed.length} PASS, ${failed.length} FAIL`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const r of failed) console.log(`  - ${r.scenario} | ${r.name}${r.detail ? ` -- ${r.detail}` : ''}`);
  }
  console.log(`screenshots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(1);
});
