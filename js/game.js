import { loadRandomPersona } from './data.js';
import { createLLM, NO_SERVER_MSG } from './llm.js';
import { installDebug, dbg } from './debug.js';
import { fetchSkill, parseSkill, buildSystemPrompt, trimHistory, appearanceLine } from './prompt.js';
import { REFUSAL_LINE, turnsForLevel, isDirectJobQuestion, resolveGuess, leaksJob } from './rules.js';
const NEAR_LINE = '（笑了笑）有點接近喔！';
const ROLE_HINT_LINE = '（眨眨眼）方向對了一半，再說具體一點是哪一種？';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
const FAKE = !MOCK && params.get('fake') === '1';
const SAVE_KEY = 'rpt-session-v1';
const BEST_KEY = 'rpt-best-level';

const state = {
  level: 1, turnsLeft: 10, persona: null, history: [], used: new Set(),
  busy: false, over: false, resumed: false, won: false, llm: null, skill: null, started: false,
};

function getBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}
function setBest(n) {
  try { localStorage.setItem(BEST_KEY, String(n)); } catch { /* ignore */ }
}

// Persist the in-progress game so an accidental page reload (tab refreshed, server hiccup...)
// drops the player back into the same game instead of the start screen.
function saveSession() {
  try {
    if (!state.persona || state.over) { sessionStorage.removeItem(SAVE_KEY); return; }
    sessionStorage.setItem(SAVE_KEY, JSON.stringify({
      mode: MOCK ? 'mock' : FAKE ? 'fake' : 'real',
      level: state.level, turnsLeft: state.turnsLeft, persona: state.persona,
      history: state.history, used: [...state.used],
      log: [...$('chat').querySelectorAll('.msg:not(.typing)')].map((el) => ({ kind: el.className.replace('msg ', ''), who: el.querySelector('.who')?.textContent || '', text: el.lastChild?.textContent || '' })),
    }));
  } catch (e) { dbg('save-failed', e); }
}
function loadSession() {
  try {
    const d = JSON.parse(sessionStorage.getItem(SAVE_KEY) || 'null');
    const mode = MOCK ? 'mock' : FAKE ? 'fake' : 'real';
    return d && d.mode === mode && d.persona && d.turnsLeft > 0 ? d : null;
  } catch { return null; }
}

function renderGuest() {
  const { info } = state.persona;
  $('guest').innerHTML = '';
  const b = document.createElement('b'); b.textContent = info.display_name;
  $('guest').append(b, ` · ${info.age_years} 歲 · ${info.gender}`, document.createElement('br'), `外觀：${appearanceLine(info)}`);
}

function renderStats() {
  $('stLevel').textContent = state.level;
  $('stTurns').textContent = state.turnsLeft;
  $('stTurns').parentElement.classList.toggle('low', state.turnsLeft <= 2);
  $('stBest').textContent = getBest();
}

function addMsg(kind, text, who) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  if (who) {
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    el.appendChild(w);
  }
  el.appendChild(document.createTextNode(text));
  $('chat').appendChild(el);
  $('chat').scrollTop = $('chat').scrollHeight;
  return el;
}

function setBusy(b) {
  state.busy = b;
  $('sendBtn').disabled = b || state.over;
  $('input').disabled = state.over;
}

async function newRound() {
  $('endCard').hidden = true;
  $('chat').innerHTML = '';
  state.over = false; state.won = false; state.history = [];
  state.turnsLeft = turnsForLevel(state.level);
  setBusy(true);
  addMsg('sys', '一位客人走了過來…');
  try {
    state.persona = await loadRandomPersona('./data', Math.random, { excludeOccupationIds: state.used });
  } catch (e) {
    addMsg('sys', `載入客人資料失敗：${e.message}`);
    return;
  }
  state.used.add(state.persona.ids.occupation);
  renderGuest();
  addMsg('sys', `第 ${state.level} 關：你有 ${state.turnsLeft} 次機會。每則訊息都算一次。`);
  renderStats();
  saveSession();
  setBusy(false);
  $('input').focus();
}

async function guestReply(onToken) {
  let compact = false;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply = '';
    try {
      const system = buildSystemPrompt(state.persona, state.skill, { forceCompact: compact });
      const messages = [{ role: 'system', content: system }, ...trimHistory(state.history, compact ? 6 : 20, compact ? 800 : 2400)];
      reply = await state.llm.chat(messages, { persona: state.persona, temperature: attempt ? 0.6 : 0.8, onToken });
    } catch (e) {
      dbg('chat-error', e);
      lastErr = e;
      compact = true; // e.g. context window exceeded: retry once with the compact prompt
      continue;
    }
    if (reply && !leaksJob(reply, state.persona.occupation)) return reply;
    onToken?.(''); // leaked the job title: discard what was streamed and retry
  }
  if (lastErr) throw lastErr;
  return '（晃了晃杯子）嗯……這個話題先跳過，再給我點酒吧。';
}

async function onSend(text) {
  if (state.busy || state.over || !state.persona) return false;
  text = String(text ?? '').trim();
  if (!text) return false;
  setBusy(true);
  const me = addMsg('me', text);
  const histLen = state.history.length;
  state.history.push({ role: 'user', content: text });
  state.turnsLeft--; // every user message counts, including guesses and refused questions
  renderStats();
  const occ = state.persona.occupation;
  let outcome = 'chat';
  let reply = '';
  let failed = null;
  const typing = addMsg('guest typing', '…', state.persona.info.display_name);
  try {
    // 1. Guess check FIRST: deterministic, then LLM judge.
    // Deterministic gates decide; the LLM judge only breaks ties on borderline candidates (see rules.js).
    const direct = isDirectJobQuestion(text);
    let correct = false;
    let near = false;
    let roleOnly = false;
    if (!direct) {
      const r = await resolveGuess(text, occ, (a) => state.llm.judge(a));
      correct = r.correct;
      near = r.near;
      roleOnly = r.roleOnly;
      dbg('guess', { candidate: r.candidate, verdict: r.verdict, score: r.score, correct });
    }
    if (correct) {
      outcome = 'win';
    } else if (direct) {
      // 2. Direct job question: fixed refusal, no model.
      reply = REFUSAL_LINE;
    } else {
      // 3. In-character reply.
      const prefix = roleOnly ? ROLE_HINT_LINE : near ? NEAR_LINE : '';
      // Stream into the typing bubble; never display text that already contains the job title.
      const onToken = (t) => {
        const shown = t && !leaksJob(t, occ) ? prefix + t : '…';
        typing.lastChild.textContent = shown;
        $('chat').scrollTop = $('chat').scrollHeight;
      };
      reply = prefix + await guestReply(onToken);
    }
  } catch (e) {
    failed = e;
    dbg('send-error', e);
  }
  typing.remove();
  if (failed) {
    // Model failure: never leave the game. Refund the turn, drop the failed exchange, let them retry.
    state.history.length = histLen;
    state.turnsLeft++;
    me.remove();
    renderStats();
    addMsg('sys', `⚠️ 客人這次沒聽清楚（${failed?.message || failed}）。這則訊息不算次數，請再送一次。`);
    $('input').value = text;
    setBusy(false);
    saveSession();
    return false;
  }
  if (reply) {
    addMsg('guest', reply, state.persona.info.display_name);
    state.history.push({ role: 'assistant', content: reply });
  }
  if (outcome === 'win') { win(); return true; }
  if (state.turnsLeft <= 0) { lose(); return true; }
  saveSession();
  setBusy(false);
  $('input').focus();
  return true;
}

function win() {
  state.over = true; state.won = true;
  saveSession();
  const reached = state.level;
  if (reached > getBest()) setBest(reached);
  renderStats();
  const occ = state.persona.occupation;
  addMsg('guest', '哈，被你看穿了！', state.persona.info.display_name);
  showCard('win', '🎉 答對了！', `${state.persona.info.display_name} 的職業是`, occ.job_title, '下一位客人', () => {
    state.level++;
    newRound();
  });
  setBusy(false);
}

function lose() {
  state.over = true;
  saveSession();
  const reached = state.level;
  if (reached > getBest()) setBest(reached);
  renderStats();
  showCard('lose', '遊戲結束', `次數用完了。你到達了第 ${reached} 關。正確答案是`, state.persona.occupation.job_title, '重新開始', () => {
    state.level = 1; state.used = new Set();
    newRound();
  });
  setBusy(false);
}

function showCard(kind, title, sub, answer, btnText, onClick) {
  const c = $('endCard');
  c.className = `card ${kind}`;
  c.innerHTML = '';
  const h = document.createElement('h2'); h.textContent = title;
  const p = document.createElement('p'); p.textContent = sub;
  const a = document.createElement('div'); a.className = 'ans'; a.id = 'answerText'; a.textContent = answer;
  const btn = document.createElement('button'); btn.className = 'primary'; btn.id = 'nextBtn'; btn.textContent = btnText;
  btn.addEventListener('click', onClick);
  const wrap = document.createElement('p'); wrap.append(btn);
  c.append(h, p, a, wrap);
  c.hidden = false;
  c.scrollIntoView({ block: 'nearest' });
}

async function startGame(resume = null) {
  $('startBtn').disabled = true;
  $('startErr').hidden = true;
  $('loading').hidden = false;
  try {
    state.skill = parseSkill(await fetchSkill('./skill.md'));
    state.llm = createLLM({ mock: MOCK, fake: FAKE });
    await state.llm.init(({ progress, text }) => {
      $('barFill').style.width = `${Math.round((progress || 0) * 100)}%`;
      $('loadText').textContent = text || '載入中…';
    });
  } catch (e) {
    $('startErr').textContent = `無法啟動：${e.message || e}`;
    $('startErr').hidden = false;
    $('startBtn').disabled = false;
    $('loading').hidden = true;
    return;
  }
  $('start').hidden = true;
  $('topbar').hidden = false;
  $('gameView').hidden = false;
  state.started = true;
  if (resume) {
    Object.assign(state, { level: resume.level, turnsLeft: resume.turnsLeft, persona: resume.persona, history: resume.history, used: new Set(resume.used), over: false, won: false });
    $('chat').innerHTML = '';
    for (const m of resume.log || []) addMsg(m.kind, m.text, m.who);
    addMsg('sys', '已從中斷處恢復遊戲。');
    renderGuest(); renderStats(); setBusy(false);
    return;
  }
  await newRound();
}

async function boot() {
  $('stBest').textContent = getBest();
  $('startBtn').addEventListener('click', () => startGame());
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('input').value;
    $('input').value = '';
    onSend(v).catch((err) => { dbg('onSend-crash', err); setBusy(false); });
  });
  if (!MOCK && !FAKE && location.protocol === 'file:') {
    $('gpuWarn').textContent = NO_SERVER_MSG;
    $('gpuWarn').hidden = false;
    $('startBtn').disabled = true;
    return;
  }
  const saved = loadSession();
  if (saved) { state.resumed = true; dbg('resume', `level=${saved.level} turns=${saved.turnsLeft}`); startGame(saved); }
}

window.__game = {
  state,
  get answer() { return state.persona?.occupation?.job_title; },
  send: onSend,
};

installDebug();
boot().catch((e) => dbg('boot-error', e));
