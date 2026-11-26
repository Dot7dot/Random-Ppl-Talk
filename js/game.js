import { loadRandomPersona } from './data.js';
import { createLLM, NO_SERVER_MSG } from './llm.js';
import { installDebug, dbg } from './debug.js';
import { loadSkillOnce, buildSystemPrompt, trimHistory, appearanceLine, verdictDirective, withDirective } from './prompt.js';
import { turnsForLevel, resolveGuess, leaksJob, classifyMessage, cannedReply, replyViolation, normalize, WIN_CLAIM_RE } from './rules.js';
const NEAR_LINE = '（笑了笑）有點接近喔！';
const ROLE_HINT_LINE = '（眨眨眼）方向對了一半，再說具體一點是哪一種？';
const WRONG_FALLBACKS = ['（笑了笑）沒有喔，再猜猜看。', '（搖搖頭）不是這個，不過你觀察得蠻有趣的。'];
const DOMAIN_HINT_LINE = '（笑）方向對了，但你說的是一個東西／領域，不是職業喔。';
const CHAT_FALLBACK = '（晃了晃杯子）嗯……這個話題先跳過，再給我點酒吧。';
const OPENER_USER = '（調酒師向你點頭示意，你在吧台坐了下來。）';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
const FAKE = !MOCK && params.get('fake') === '1';
const SAVE_KEY = 'rpt-session-v1';
const BEST_KEY = 'rpt-best-level';

const state = {
  level: 1, turnsLeft: 10, persona: null, history: [], used: new Set(), guessed: new Set(), repeats: 0,
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
      history: state.history, used: [...state.used], guessed: [...state.guessed],
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
  state.over = false; state.won = false; state.history = []; state.guessed = new Set(); state.repeats = 0;
  state.turnsLeft = turnsForLevel(state.level);
  setBusy(true);
  addMsg('sys', '一位客人走了過來…');
  // Phase 1: read the rulebook (cached after the first load; refuse to play without it).
  addMsg('sys', '📖 讀取規則書…');
  try {
    state.skill = await loadSkillOnce('./skill.md');
  } catch (e) {
    addMsg('sys', `⚠️ ${e.message || e}`);
    return;
  }
  try {
    state.persona = await loadRandomPersona('./data', Math.random, { excludeOccupationIds: state.used });
  } catch (e) {
    addMsg('sys', `載入客人資料失敗：${e.message}`);
    return;
  }
  state.used.add(state.persona.ids.occupation);
  // Phase 2: connect to the persona.
  addMsg('sys', `🔗 連線人物：${state.persona.info.display_name}…`);
  renderGuest();
  addMsg('sys', `第 ${state.level} 關：你有 ${state.turnsLeft} 次機會。每則訊息都算一次。`);
  renderStats();
  // Phase 3: the guest opens the conversation in character (does not cost a turn).
  const typing = addMsg('guest typing', '…', state.persona.info.display_name);
  let opening = '';
  try {
    opening = await generate({ history: [{ role: 'user', content: OPENER_USER }], kind: 'opening', onToken: (t) => { typing.lastChild.textContent = t && !leaksJob(t, state.persona.occupation) ? t : '…'; } });
  } catch (e) { dbg('opening-error', e); }
  typing.remove();
  if (!opening) opening = openingFallback();
  addMsg('guest', opening, state.persona.info.display_name);
  state.history = [{ role: 'user', content: OPENER_USER }, { role: 'assistant', content: opening }];
  saveSession();
  setBusy(false);
  $('input').focus();
}

function openingFallback() {
  const phrase = state.persona.traits?.catchphrases?.[0]?.phrase || '';
  return `（在吧台坐下）晚安，先來杯酒吧。${phrase}`.trim();
}

// One model reply with the program's verdict attached as a hidden instruction for this turn.
// Returns '' when the model keeps breaking the rules (caller falls back to a canned line); throws on model/server errors.
async function generate({ history, kind, tags = [], lastTurn = false, onToken, allowTitle = false }) {
  const occ = state.persona.occupation;
  let compact = false;
  let lastErr = null;
  let strict = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply = '';
    try {
      const system = buildSystemPrompt(state.persona, state.skill, { forceCompact: compact });
      const directive = verdictDirective(kind, { title: occ.job_title, tags, lastTurn, strict });
      const messages = [{ role: 'system', content: system }, ...withDirective(trimHistory(history, compact ? 6 : 20, compact ? 800 : 2400), directive)];
      reply = await state.llm.chat(messages, { persona: state.persona, temperature: attempt ? 0.6 : 0.8, onToken });
    } catch (e) {
      dbg('chat-error', e);
      lastErr = e;
      compact = true; // e.g. context window exceeded: retry once with the compact prompt
      continue;
    }
    reply = String(reply || '').replace(/[【】]/g, '').trim();
    const bad = allowTitle ? (reply ? null : 'empty') : replyViolation(reply, occ);
    if (!bad) return reply;
    dbg('reply-rejected', bad);
    strict = true;
    onToken?.(''); // discard what was streamed and retry once
  }
  if (lastErr && !strict) throw lastErr;
  return '';
}

async function onSend(text) {
  if (state.busy || state.over || !state.persona) return false;
  text = String(text ?? '').trim();
  if (!text) return false;
  setBusy(true);
  const me = addMsg('me', text);
  const histLen = state.history.length;
  state.history.push({ role: 'user', content: text });
  state.turnsLeft--; // every user message counts, whatever its type
  renderStats();
  const occ = state.persona.occupation;
  const name = state.persona.info.display_name;
  let outcome = 'chat';
  let reply = '';
  let failed = null;
  const typing = addMsg('guest typing', '…', name);
  const show = (prefix = '', allowTitle = false) => (t) => {
    const ok = t && (allowTitle || (!leaksJob(t, occ) && !WIN_CLAIM_RE.test(t)));
    typing.lastChild.textContent = ok ? prefix + t : '…';
    $('chat').scrollTop = $('chat').scrollHeight;
  };
  try {
    // 1. Classify BEFORE any model call (rules.js is the authority: the model never decides a win).
    const cls = classifyMessage(text, occ, { guessed: state.guessed, turnsLeft: state.turnsLeft });
    dbg('classify', { type: cls.type, subtype: cls.subtype, candidates: cls.candidates, reason: cls.reason });
    const canned = cannedReply(cls, state.repeats);
    const lastTurn = state.turnsLeft === 1;
    if (canned) {
      // 2. Fixed replies (direct question, injection, too long, gibberish, scattershot, repeat): no model.
      if (cls.type === 'repeat_guess') state.repeats++;
      reply = canned;
    } else if (cls.type === 'single_guess') {
      // 3. Single guess: deterministic gates + (borderline only) LLM tie-breaker.
      const r = await resolveGuess(text, occ, (a) => state.llm.judge(a));
      dbg('guess', { candidate: r.candidate, verdict: r.verdict, score: r.score, correct: r.correct });
      if (r.correct) {
        outcome = 'win';
        // 4a. Verdict = correct: the guest reveals in character (title allowed), THEN the win card.
        let rev = '';
        try { rev = await generate({ history: state.history, kind: 'correct', onToken: show('', true), allowTitle: true }); } catch (e) { dbg('reveal-error', e); }
        reply = rev || `（愣住，隨即笑了）哈，被你看穿了！我真的是${occ.job_title}。`;
      } else {
        if (r.candidate) state.guessed.add(normalize(r.candidate));
        const roleOnly = !!r.roleOnly;
        const near = !roleOnly && !!r.near;
        const prefix = roleOnly ? ROLE_HINT_LINE : r.domain ? DOMAIN_HINT_LINE : near ? NEAR_LINE : '';
        const kind = roleOnly ? 'roleonly' : near ? 'near' : 'wrong';
        // 4b. Verdict = wrong: post-checked reply (no win claims, no title), canned denial as the last resort.
        const rep = await generate({ history: state.history, kind, tags: cls.tags, lastTurn, onToken: show(prefix) });
        reply = prefix + (rep || WRONG_FALLBACKS[state.guessed.size % WRONG_FALLBACKS.length]);
      }
    } else {
      // 5. Chat / yes-no domain question.
      const kind = cls.type === 'domain_question' ? 'domain' : 'chat';
      reply = (await generate({ history: state.history, kind, tags: cls.tags, lastTurn, onToken: show() })) || CHAT_FALLBACK;
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
    addMsg('guest', reply, name);
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
  if (state.over) return; // level / best / card happen exactly once
  state.over = true; state.won = true;
  saveSession();
  const reached = state.level;
  if (reached > getBest()) setBest(reached);
  renderStats();
  const occ = state.persona.occupation;
  showCard('win', '🎉 答對了！', `${state.persona.info.display_name} 的職業是`, occ.job_title, '下一位客人', () => {
    state.level++;
    newRound();
  });
  setBusy(false);
}

function lose() {
  if (state.over) return;
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
    state.skill = await loadSkillOnce('./skill.md'); // read + validate the rulebook once; no rulebook, no game
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
    Object.assign(state, { level: resume.level, turnsLeft: resume.turnsLeft, persona: resume.persona, history: resume.history, used: new Set(resume.used), guessed: new Set(resume.guessed || []), repeats: 0, over: false, won: false });
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
    $('srvWarn').textContent = NO_SERVER_MSG;
    $('srvWarn').hidden = false;
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
