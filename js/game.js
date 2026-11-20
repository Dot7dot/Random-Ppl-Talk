import { loadRandomPersona } from './data.js';
import { createLLM, MODELS, checkWebGPU, isMobileDevice, isDeviceLostError, LIGHT_MODEL } from './llm.js';
import { installDebug, dbg } from './debug.js';
import { fetchSkill, parseSkill, buildSystemPrompt, trimHistory, appearanceLine } from './prompt.js';
import { REFUSAL_LINE, turnsForLevel, isDirectJobQuestion, resolveGuess, leaksJob } from './rules.js';
const NEAR_LINE = '（笑了笑）有點接近喔！';

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

const MODEL_KEY = 'rpt-model';
const GEN_KEY = 'rpt-generating';
const CRASH_KEY = 'rpt-crashes';
const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }, del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } } };
const getModelPref = () => { try { return localStorage.getItem(MODEL_KEY); } catch { return null; } };
const setModelPref = (m) => { try { localStorage.setItem(MODEL_KEY, m); } catch { /* ignore */ } };
const markGenerating = () => ss.set(GEN_KEY, String(Date.now()));
const clearGenerating = () => ss.del(GEN_KEY);
const crashOk = () => ss.del(CRASH_KEY);

function getBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}
function setBest(n) {
  try { localStorage.setItem(BEST_KEY, String(n)); } catch { /* ignore */ }
}

// Persist the in-progress game so an accidental page reload (mobile tab killed, GPU reset...)
// drops the player back into the same game instead of the start screen.
function saveSession() {
  try {
    if (!state.persona || state.over) { sessionStorage.removeItem(SAVE_KEY); return; }
    sessionStorage.setItem(SAVE_KEY, JSON.stringify({
      mode: MOCK ? 'mock' : FAKE ? 'fake' : 'real', modelId: $('modelSel').value,
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

async function guestReply() {
  let compact = false;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply = '';
    try {
      const system = buildSystemPrompt(state.persona, state.skill, { forceCompact: compact });
      const messages = [{ role: 'system', content: system }, ...trimHistory(state.history, compact ? 4 : 8, compact ? 400 : 900)];
      reply = await state.llm.chat(messages, { persona: state.persona, temperature: attempt ? 0.6 : 0.8 });
    } catch (e) {
      dbg('chat-error', e);
      lastErr = e;
      compact = true; // e.g. context window exceeded: retry once with the compact prompt
      continue;
    }
    if (reply && !leaksJob(reply, state.persona.occupation)) return reply;
  }
  if (lastErr) throw lastErr;
  return '（晃了晃杯子）嗯……這個話題先跳過，再給我點酒吧。';
}

async function onSend(text) {
  if (state.busy || state.over || !state.persona) return false;
  text = String(text ?? '').trim();
  if (!text) return false;
  setBusy(true);
  markGenerating();
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
    if (!direct) {
      const r = await resolveGuess(text, occ, (a) => state.llm.judge(a));
      correct = r.correct;
      near = r.near;
      dbg('guess', { candidate: r.candidate, verdict: r.verdict, score: r.score, correct });
    }
    if (correct) {
      outcome = 'win';
    } else if (direct) {
      // 2. Direct job question: fixed refusal, no model.
      reply = REFUSAL_LINE;
    } else {
      // 3. In-character reply.
      reply = await guestReply();
      if (near) reply = `${NEAR_LINE}${reply}`;
    }
  } catch (e) {
    failed = e;
    dbg('send-error', e);
  }
  typing.remove();
  clearGenerating();
  if (!failed) crashOk();
  if (failed) {
    // Model failure: never leave the game. Refund the turn, drop the failed exchange, let them retry.
    state.history.length = histLen;
    state.turnsLeft++;
    me.remove();
    renderStats();
    if (failed.deviceLost || isDeviceLostError(failed)) {
      await recoverLLM();
    }
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

// Engine died (GPU device lost / OOM): reload it with the light model so the player can retry.
async function recoverLLM() {
  try {
    setModelPref(LIGHT_MODEL);
    addMsg('sys', '手機記憶體不足，正在切換為輕量模型…');
    markGenerating();
    state.llm = createLLM({ mock: MOCK, fake: FAKE, modelId: LIGHT_MODEL });
    await state.llm.init(() => {});
    clearGenerating();
    addMsg('sys', '已切換為輕量模型（Qwen2.5 0.5B）。');
  } catch (e) {
    clearGenerating();
    dbg('recover-failed', e);
    addMsg('sys', `無法重新載入模型：${e.message || e}。請關閉其他分頁或改用桌面瀏覽器。`);
  }
}

async function startGame(resume = null, notice = '') {
  $('startBtn').disabled = true;
  $('startErr').hidden = true;
  $('loading').hidden = false;
  markGenerating(); // model loading can also OOM the tab
  try {
    state.skill = parseSkill(await fetchSkill('./skill.md'));
    state.llm = createLLM({ mock: MOCK, fake: FAKE, modelId: getModelPref() && resume ? getModelPref() : resume?.modelId || $('modelSel').value });
    await state.llm.init(({ progress, text }) => {
      $('barFill').style.width = `${Math.round((progress || 0) * 100)}%`;
      $('loadText').textContent = text || '載入中…';
    });
    clearGenerating();
  } catch (e) {
    clearGenerating();
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
    if (notice) addMsg('sys', notice);
    renderGuest(); renderStats(); setBusy(false);
    return;
  }
  await newRound();
}

async function boot() {
  const sel = $('modelSel');
  for (const m of MODELS) sel.add(new Option(m.label, m.id));
  if (MOCK || FAKE) {
    sel.add(new Option(MOCK ? '模擬模式（不使用模型）' : '假引擎（開發測試）', MOCK ? 'mock' : 'fake'));
    sel.value = MOCK ? 'mock' : 'fake';
  }
  $('stBest').textContent = getBest();
  // Default model: light one on phones / low-limit adapters, 1.5B on desktop; remembered choice wins.
  let preferLight = isMobileDevice();
  if (!MOCK && !FAKE) {
    const gpu = await checkWebGPU();
    if (!gpu.ok) {
      $('gpuWarn').textContent = gpu.reason;
      $('gpuWarn').hidden = false;
      $('startBtn').disabled = true;
    } else if (gpu.lowMemory) preferLight = true;
  }
  const pref = getModelPref();
  if (pref && MODELS.some((m) => m.id === pref)) $('modelSel').value = pref;
  else if (preferLight && !MOCK && !FAKE) $('modelSel').value = LIGHT_MODEL;
  $('modelSel').addEventListener('change', () => setModelPref($('modelSel').value));
  $('startBtn').addEventListener('click', () => startGame());
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('input').value;
    $('input').value = '';
    onSend(v).catch((err) => { dbg('onSend-crash', err); setBusy(false); });
  });
  // Crash detection: the generating flag survives only if the page died mid-load/generation.
  let notice = '';
  if (ss.get(GEN_KEY)) {
    clearGenerating();
    const crashes = (Number(ss.get(CRASH_KEY)) || 0) + 1;
    ss.set(CRASH_KEY, String(crashes));
    dbg('crash-detected', `count=${crashes}`);
    const wasLight = (getModelPref() || '') === LIGHT_MODEL;
    if (crashes >= 2) {
      ss.del(SAVE_KEY); ss.del(CRASH_KEY);
      setModelPref(LIGHT_MODEL);
      if (MODELS.some((m) => m.id === LIGHT_MODEL)) $('modelSel').value = LIGHT_MODEL;
      $('startErr').textContent = '頁面連續當機，可能是手機記憶體不足。請關閉其他分頁或 App、重新整理後再試，或改用桌面瀏覽器。已為你選好輕量模型。';
      $('startErr').hidden = false;
      return;
    }
    notice = wasLight ? '頁面意外重新整理，可能是記憶體不足。建議關閉其他分頁。' : '手機記憶體不足，已自動切換為輕量模型';
    setModelPref(LIGHT_MODEL);
    if (MODELS.some((m) => m.id === LIGHT_MODEL)) $('modelSel').value = LIGHT_MODEL;
  }
  const saved = loadSession();
  if (saved && !$('startBtn').disabled) { state.resumed = true; dbg('resume', `level=${saved.level} turns=${saved.turnsLeft}`); startGame(saved, notice); }
  else if (notice) { $('startErr').textContent = notice; $('startErr').hidden = false; }
}

window.__game = {
  state,
  get answer() { return state.persona?.occupation?.job_title; },
  send: onSend,
};

installDebug();
boot().catch((e) => dbg('boot-error', e));
