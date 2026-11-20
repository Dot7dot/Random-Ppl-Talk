import { loadRandomPersona } from './data.js';
import { createLLM, MODELS, checkWebGPU } from './llm.js';
import { fetchSkill, parseSkill, buildSystemPrompt, trimHistory, appearanceLine } from './prompt.js';
import { REFUSAL_LINE, turnsForLevel, isDirectJobQuestion, deterministicGuess, leaksJob } from './rules.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
const BEST_KEY = 'rpt-best-level';

const state = {
  level: 1, turnsLeft: 10, persona: null, history: [], used: new Set(),
  busy: false, over: false, won: false, llm: null, skill: null, started: false,
};

function getBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}
function setBest(n) {
  try { localStorage.setItem(BEST_KEY, String(n)); } catch { /* ignore */ }
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
  const { info } = state.persona;
  $('guest').innerHTML = '';
  const b = document.createElement('b'); b.textContent = info.display_name;
  $('guest').append(b, ` · ${info.age_years} 歲 · ${info.gender}`, document.createElement('br'), `外觀：${appearanceLine(info)}`);
  addMsg('sys', `第 ${state.level} 關：你有 ${state.turnsLeft} 次機會。每則訊息都算一次。`);
  renderStats();
  setBusy(false);
  $('input').focus();
}

async function guestReply() {
  const system = buildSystemPrompt(state.persona, state.skill);
  const messages = [{ role: 'system', content: system }, ...trimHistory(state.history)];
  let reply = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    reply = await state.llm.chat(messages, { persona: state.persona, temperature: attempt ? 0.6 : 0.8 });
    if (reply && !leaksJob(reply, state.persona.occupation)) return reply;
  }
  return '（晃了晃杯子）嗯……這個話題先跳過，再給我點酒吧。';
}

async function onSend(text) {
  if (state.busy || state.over) return;
  text = text.trim();
  if (!text) return;
  setBusy(true);
  addMsg('me', text);
  state.history.push({ role: 'user', content: text });
  state.turnsLeft--; // every user message counts, including guesses and refused questions
  renderStats();
  const occ = state.persona.occupation;
  let outcome = 'chat';
  let reply = '';
  const typing = addMsg('guest typing', '…', state.persona.info.display_name);
  try {
    // 1. Guess check FIRST: deterministic, then LLM judge.
    let correct = deterministicGuess(text, occ);
    const direct = isDirectJobQuestion(text);
    if (!correct && !direct) {
      try {
        const j = await state.llm.judge({ occupation: occ, text });
        correct = !!(j.is_guess && j.correct);
      } catch (e) { console.warn('judge failed', e); }
    }
    if (correct) {
      outcome = 'win';
    } else if (direct) {
      // 2. Direct job question: fixed refusal, no model.
      reply = REFUSAL_LINE;
    } else {
      // 3. In-character reply.
      reply = await guestReply();
    }
  } catch (e) {
    reply = `（出了點問題：${e.message}）`;
  }
  typing.remove();
  if (reply) {
    addMsg('guest', reply, state.persona.info.display_name);
    state.history.push({ role: 'assistant', content: reply });
  }
  if (outcome === 'win') return win();
  if (state.turnsLeft <= 0) return lose();
  setBusy(false);
  $('input').focus();
}

function win() {
  state.over = true; state.won = true;
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

async function startGame() {
  $('startBtn').disabled = true;
  $('startErr').hidden = true;
  $('loading').hidden = false;
  try {
    state.skill = parseSkill(await fetchSkill('./skill.md'));
    state.llm = createLLM({ mock: MOCK, modelId: $('modelSel').value });
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
  await newRound();
}

async function boot() {
  const sel = $('modelSel');
  for (const m of MODELS) sel.add(new Option(m.label, m.id));
  if (MOCK) {
    sel.add(new Option('模擬模式（不使用模型）', 'mock'));
    sel.value = 'mock';
  }
  $('stBest').textContent = getBest();
  if (!MOCK) {
    const gpu = await checkWebGPU();
    if (!gpu.ok) {
      $('gpuWarn').textContent = gpu.reason;
      $('gpuWarn').hidden = false;
      $('startBtn').disabled = true;
    }
  }
  $('startBtn').addEventListener('click', startGame);
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('input').value;
    $('input').value = '';
    onSend(v);
  });
}

window.__game = {
  state,
  get answer() { return state.persona?.occupation?.job_title; },
  send: onSend,
};

boot();
