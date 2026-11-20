// Guess-judging safety net over all occupations. Run: node --test tests/judge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveGuess, IDENTITY_ROLES } from '../js/rules.js';

const dir = new URL('../data/occupations/', import.meta.url);
const occs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')));

const alwaysYes = async () => ({ is_guess: true, correct: true });
const stats = { nonGuess: 0, nonGuessWins: 0, right: 0, rightTotal: 0, other: 0, otherWins: 0 };
const failures = [];

const NON_GUESS = [
  '嗨', '嗨嗨', '你好', '哈囉', '今天好累', '來杯啤酒', '你住哪', '謝謝', '哈哈', '?', '？？', '好', '嗯嗯', '😀😀', '🍺',
  '晚安', '你今天心情怎麼樣', '你有養寵物嗎', '你平常假日都做什麼', '你家有幾個人', '你有兄弟姊妹嗎', '最近身體還好嗎',
  '你喜歡看電影還是打球', '今天天氣真好，外面一直下雨，不過店裡很溫暖，你要不要再來一杯', '我昨天去看了醫生，他說我要早點睡',
  '你是誰', '你是哪裡人', '你是不是很累', '你不是本地人吧', '你是男的嗎', '你有沒有喜歡的歌', '再來一杯威士忌', '我是這間店的調酒師',
  'hello', 'hi hi', 'lol', '你吃飯了嗎', '你結婚了嗎', '為什麼今天這麼晚才來', '給你一杯馬丁尼',
];

test('(a) non-guess messages never win, even with an always-yes judge', async () => {
  for (const o of occs) for (const m of NON_GUESS) {
    stats.nonGuess++;
    const r = await resolveGuess(m, o, alwaysYes);
    if (r.correct) { stats.nonGuessWins++; failures.push(`(a) ${o.job_title} <- ${m}`); }
  }
  assert.equal(stats.nonGuessWins, 0, failures.join('\n'));
});

test('(b) correct guesses win', async () => {
  const strip = (s) => s.replace(/(?:工程師|技術員|技師|專員|人員|督導員|指導員|研究員|分析員|分析師|規劃員|規劃師|查驗員|協調員|統籌員|訓練員|培訓員|教練|領班|督導|主管|組長|講師|導師|設計師|師|員|家|工|手|長|生|官|匠|商|者)$/, '');
  const bad = [];
  for (const o of occs) {
    const T = o.job_title;
    const forms = [`你是${T}嗎？`, `我猜你是${T}`, `是不是${T}？`, `你應該是${T}吧`, `你該不會是${T}吧！`, `${T}？`, `你在當${T}吧`, `職業是${T}`, `你是做${strip(T)}的吧`, `你是不是做${strip(T)}的？`];
    for (const f of forms) {
      stats.rightTotal++;
      const r = await resolveGuess(f, o, async () => ({ is_guess: true, correct: false }));
      if (r.correct) stats.right++; else bad.push(`${T} <- ${f} [${r.candidate}/${r.verdict}]`);
    }
  }
  console.log(`(b) correct guesses accepted: ${stats.right}/${stats.rightTotal}`);
  assert.equal(bad.length, 0, bad.slice(0, 20).join('\n'));
});

test('(b2) aliases / short forms', async () => {
  const get = (id) => occs.find((o) => o.id === id);
  const qa = get('001');
  for (const m of ['你是QA嗎', '你是測試工程師吧', '軟體測試？', '你是做軟體品質保證的吧']) assert.equal((await resolveGuess(m, qa, null)).correct, true, m);
  for (const m of ['你是軟體工程師嗎', '工程師', '你是工程師嗎', '你是做IT的嗎', '上班族？', '你是上班族吧', '你是在醫院工作的嗎', '你是員工嗎', '師', '員', '工作']) assert.equal((await resolveGuess(m, qa, alwaysYes)).correct, false, m);
  const kitchen = occs.find((o) => o.job_title === '商用廚房設備維修調度員');
  for (const m of ['你是廚房設備維修的吧', '你是設備維修的嗎', '你是廚房設備調度的嗎']) assert.equal((await resolveGuess(m, kitchen, null)).correct, true, m);
  for (const m of ['你是調度員嗎', '你是維修員吧', '你是維修技師嗎']) { const r = await resolveGuess(m, kitchen, alwaysYes); assert.equal(r.correct, false, m); assert.equal(r.roleOnly, true, m); }
  for (const m of ['你是廚師嗎', '嗨嗨']) assert.equal((await resolveGuess(m, kitchen, alwaysYes)).correct, false, m);
  const cook = occs.find((o) => o.job_title === '餐飲研發廚師');
  assert.equal((await resolveGuess('你是廚師嗎', cook, null)).correct, true);
  assert.equal((await resolveGuess('廚師', cook, null)).correct, true);
  assert.equal((await resolveGuess('你不是廚師吧', cook, alwaysYes)).correct, false);
});

test('(c) guessing other occupations never wins (always-yes judge)', async () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const wins = [];
  for (const o of occs) {
    const others = occs.filter((x) => x !== o && x.job_title !== o.job_title);
    for (let k = 0; k < 20; k++) {
      const x = others[Math.floor(rnd() * others.length)];
      stats.other++;
      const r = await resolveGuess(`你是${x.job_title}嗎？`, o, alwaysYes);
      if (r.correct) { stats.otherWins++; wins.push(`${o.job_title} <- ${x.job_title} [${r.verdict}/${r.reason}]`); }
    }
  }
  console.log(`(c) false positives: ${stats.otherWins}/${stats.other}`);
  assert.equal(stats.otherWins, 0, wins.slice(0, 30).join('\n'));
});

test('(c2) short-form guesses of other occupations (informational, must stay tiny)', async () => {
  const strip = (s) => s.replace(/(?:工程師|技術員|技師|專員|人員|督導員|指導員|研究員|分析員|分析師|規劃員|規劃師|查驗員|協調員|統籌員|訓練員|培訓員|教練|領班|督導|主管|組長|講師|導師|設計師|師|員|家|工|手|長|生|官|匠|商|者)$/, '');
  let n = 0; const fp = [];
  for (let i = 0; i < occs.length; i++) for (let k = 1; k <= 10; k++) {
    const o = occs[i], x = occs[(i * 7 + k * 37) % occs.length];
    if (x.job_title === o.job_title) continue;
    n++;
    const r = await resolveGuess(`你是做${strip(x.job_title)}的吧`, o, alwaysYes);
    if (r.correct) fp.push(`${o.job_title} <- ${x.job_title} [${r.reason}]`);
  }
  console.log(`(c2) short-form false positives: ${fp.length}/${n}`, fp.slice(0, 10));
  assert.equal(fp.length, 0, fp.join('\n'));
});

test('(d) role-only spam never wins except identity whitelist', async () => {
  const roles = ['教練', '講師', '老師', '助教', '調度員', '主管', '專員', '顧問', '技師', '技術員', '操作員', '檢查員', '協調員', '管理員', '志工', '維修員', '維修師', '維修技師', '工程師', '設計師', '分析員', '督導', '領班', '組長', '師傅', '員', '師', '研究員', '規劃員', '查驗員', '指導員', '分析師', '店員', '老闆', '上班族', '工作人員', ...IDENTITY_ROLES];
  const counts = {}; const bad = []; let hints = 0;
  for (const w of roles) {
    counts[w] = 0;
    for (const o of occs) for (const m of [`你是${w}嗎？`, w, `我猜你是${w}吧`]) {
      const r = await resolveGuess(m, o, alwaysYes);
      if (r.correct) {
        counts[w]++;
        if (!(IDENTITY_ROLES.includes(w) && normalizeIncludes(o.job_title, w))) bad.push(`${o.job_title} <- ${m}`);
      }
      if (r.roleOnly) hints++;
    }
  }
  const wins = Object.entries(counts).filter(([, n]) => n).map(([w, n]) => `${w}:${n / 3}`);
  console.log(`(d) role-only wins per word (titles of 400; only whitelist expected): ${wins.join(' ') || 'none'}; hint replies: ${hints}`);
  assert.equal(bad.length, 0, bad.slice(0, 20).join('\n'));
  const get = (t) => occs.find((o) => o.job_title === t);
  const yes = async () => ({ is_guess: true, correct: true });
  assert.equal((await resolveGuess('你是教練嗎', get('巷弄週末市集新攤入場教練'), yes)).roleOnly, true);
  for (const [t, m] of [['巷弄週末市集新攤入場教練', '你是市集教練嗎'], ['舊衣布料再用拆解志工教練', '你是拆解教練吧'], ['鐵路行車調度員', '你是鐵路調度員嗎'], ['自行車維修技師', '你是自行車技師嗎'], ['鐘錶維修師', '你是鐘錶維修嗎'], ['餐飲研發廚師', '廚師？']]) {
    assert.equal((await resolveGuess(m, get(t), null)).correct, true, `${t} <- ${m}`);
  }
});

test('(e) reordered paraphrases are accepted (>=95%)', async () => {
  const ROLES = ['工程師', '技術員', '督導員', '指導員', '研究員', '分析員', '分析師', '規劃師', '規劃員', '查驗員', '協調員', '統籌員', '訓練員', '培訓員', '專員', '技師', '人員', '助教', '教練', '領班', '督導', '主管', '組長', '講師', '導師', '設計師', '師', '員'];
  const fails = []; let n = 0;
  const kitchen = occs.find((o) => o.job_title === '商用廚房設備維修調度員');
  for (const m of ['我猜你是維修廚房設備的調度員', '你是負責廚房設備維修調度的嗎', '你是做廚房設備維修的調度員吧']) assert.equal((await resolveGuess(m, kitchen, null)).correct, true, m);
  for (const o of occs) {
    const T = o.job_title;
    const role = ROLES.find((r) => T.endsWith(r) && T.length > r.length) || '';
    const core = T.slice(0, T.length - role.length);
    const h = Math.ceil(core.length / 2);
    const [a, b] = [core.slice(0, h), core.slice(h)];
    const q = Math.ceil(core.length / 3);
    const [x, y, z] = [core.slice(0, q), core.slice(q, 2 * q), core.slice(2 * q)];
    for (const f of [`我猜你是${b}${a}的${role}`, `你是負責${b}${a}的${role}嗎`, `你是${z}${x}${y}的${role}吧`, `是不是${b}${a}的${role}`]) {
      n++;
      const r = await resolveGuess(f, o, async () => ({ is_guess: true, correct: false }));
      if (!r.correct) fails.push(`${T} <- ${f}`);
    }
  }
  const rate = 1 - fails.length / n;
  console.log(`(e) reordered paraphrase acceptance: ${n - fails.length}/${n} = ${(rate * 100).toFixed(1)}%`, fails.slice(0, 8));
  assert.ok(rate >= 0.95, fails.slice(0, 20).join('\n'));
});

test('(f) identity role must be the head role', async () => {
  const o = occs.find((x) => x.job_title === '校園刊物製作小記者訓練員');
  assert.equal((await resolveGuess('你是記者嗎', o, alwaysYes)).correct, false);
});

function normalizeIncludes(t, w) { return t.includes(w); }

test('(a) counts', () => {
  console.log(`(a) non-guess trials: ${occs.length} occupations x ${NON_GUESS.length} messages = ${occs.length * NON_GUESS.length}, wins: ${stats.nonGuessWins}`);
});
