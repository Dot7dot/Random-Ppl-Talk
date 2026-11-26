// LLM client. Real backend: a local llama.cpp `llama-server` (Qwen3-8B) that serves this
// game AND its OpenAI-compatible API on the same origin (see launcher/start.ps1).
// Also: a mock backend (?mock=1) and an in-browser fake engine (?fake=1) for tests.
import { buildJudgeMessages } from './prompt.js';
import { parseYesNo, matchCandidate } from './rules.js';

export const CONTEXT_WINDOW = 8192; // must match `-c` in launcher/start.ps1
export const NO_SERVER_MSG = '找不到本機模型伺服器。請雙擊 Start-Game.bat 啟動遊戲（不要直接開啟 index.html，也不要用其他網頁伺服器）。';
const NO_THINK = '/no_think';

export function createLLM({ mock = false, fake = false } = {}) {
  const llm = mock ? createMockLLM() : createServerLLM({ fake });
  return serialize(llm);
}

// One generation at a time (judge + chat must never overlap; the server has a single slot).
function serialize(llm) {
  let tail = Promise.resolve();
  const queued = (fn) => (...args) => {
    const run = tail.then(() => fn(...args));
    tail = run.catch(() => {});
    return run;
  };
  return { ...llm, chat: queued(llm.chat.bind(llm)), judge: queued(llm.judge.bind(llm)) };
}

// Conservative token estimate (CJK ~1+ token/char for Qwen, ASCII ~0.4).
export function estimateTokens(s) {
  let n = 0;
  for (const ch of String(s ?? '')) n += ch.charCodeAt(0) > 0x7f ? 1.2 : 0.4;
  return Math.ceil(n) + 4;
}
const MSG_OVERHEAD = 8;
export const promptTokens = (messages) => messages.reduce((n, m) => n + estimateTokens(m.content) + MSG_OVERHEAD, 6);

// Normalise the conversation: system first only, merge same-role neighbours, drop a leading
// assistant, last message must be from the user. Then drop oldest turns (and finally clip the
// system prompt) until the prompt fits the context window.
export function fitMessages(messages, maxTokens = 200, ctx = CONTEXT_WINDOW) {
  const budget = ctx - maxTokens - 96;
  let sys = null;
  const rest = [];
  for (const m of messages) {
    const content = String(m.content ?? '');
    if (m.role === 'system') { if (!sys && !rest.length) sys = { role: 'system', content }; continue; }
    const last = rest[rest.length - 1];
    if (last && last.role === m.role) last.content += `\n${content}`;
    else rest.push({ role: m.role, content });
  }
  while (rest.length && rest[0].role !== 'user') rest.shift();
  if (!rest.length || rest[rest.length - 1].role !== 'user') throw new Error('沒有可送出的使用者訊息');
  const build = () => (sys ? [sys, ...rest] : [...rest]);
  while (promptTokens(build()) > budget && rest.length > 1) {
    rest.shift();
    while (rest.length > 1 && rest[0].role !== 'user') rest.shift();
  }
  while (promptTokens(build()) > budget && sys && sys.content.length > 200) {
    sys = { role: 'system', content: sys.content.slice(0, Math.floor(sys.content.length * 0.85)) };
  }
  const lastU = rest[rest.length - 1];
  while (promptTokens(build()) > budget && lastU.content.length > 20) lastU.content = lastU.content.slice(0, Math.floor(lastU.content.length * 0.8));
  return build();
}

// ---------- <think> handling (Qwen3) ----------
// Visible text of everything received so far. Removes complete <think>…</think> blocks, an unclosed
// trailing <think>… (still thinking), reasoning that precedes an orphan </think>, and a trailing
// partial tag such as "<thi" that may still turn into a tag in the next chunk.
export function stripThink(raw, { streaming = false } = {}) {
  let s = String(raw ?? '');
  s = s.replace(/<think>[\s\S]*?<\/think>/g, '');
  const orphan = s.indexOf('</think>');
  if (orphan >= 0) s = s.slice(orphan + '</think>'.length);
  const open = s.indexOf('<think>');
  if (open >= 0) s = s.slice(0, open);
  if (streaming) {
    for (const tag of ['<think>', '</think>']) {
      for (let k = tag.length - 1; k > 0; k--) {
        if (s.endsWith(tag.slice(0, k))) { s = s.slice(0, s.length - k); break; }
      }
    }
  }
  return s.replace(/^\s+/, '');
}

// ---------- real backend ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiUrl = (p) => new URL(p, location.href).href;

function withNoThink(messages) {
  if (!messages.length || messages[0].role !== 'system') return messages;
  const sys = messages[0];
  if (/\/no_think\s*$/.test(sys.content)) return messages;
  return [{ ...sys, content: `${sys.content}\n${NO_THINK}` }, ...messages.slice(1)];
}

async function readError(res) {
  let msg = '';
  try {
    const j = await res.json();
    msg = j?.error?.message || '';
  } catch { /* ignore */ }
  return `模型伺服器回應錯誤 (HTTP ${res.status}${msg ? `：${msg}` : ''})`;
}

function createServerLLM({ fake = false } = {}) {
  let engine = null; // fake engine only
  const body = (messages, { temperature, max_tokens, top_p, stream }) => ({
    messages: withNoThink(messages),
    temperature, top_p, top_k: 20, max_tokens, stream,
    frequency_penalty: 0.2,
    cache_prompt: true,
    chat_template_kwargs: { enable_thinking: false },
  });

  async function post(payload, { firstByteMs = 300000, idleMs = 60000, onText } = {}) {
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(), firstByteMs);
    const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), idleMs); };
    try {
      let res;
      try {
        res = await fetch(apiUrl('v1/chat/completions'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctl.signal,
        });
      } catch (e) {
        if (ctl.signal.aborted) throw new Error('模型回應逾時');
        throw new Error('無法連線到本機模型伺服器，請確認 Start-Game.bat 的視窗還開著');
      }
      if (!res.ok) throw new Error(await readError(res));
      if (!payload.stream) {
        const j = await res.json();
        return j.choices?.[0]?.message?.content || '';
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let raw = '';
      let done = false;
      try {
        while (!done) {
          const { value, done: d } = await reader.read();
          if (d) break;
          bump();
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') { done = true; break; }
            let j;
            try { j = JSON.parse(data); } catch { continue; }
            if (j.error) throw new Error(`模型伺服器錯誤：${j.error.message || JSON.stringify(j.error)}`);
            const piece = j.choices?.[0]?.delta?.content;
            if (piece) { raw += piece; onText?.(stripThink(raw, { streaming: true })); }
          }
        }
      } catch (e) {
        if (ctl.signal.aborted) throw new Error('模型回應逾時');
        throw e;
      } finally {
        try { await reader.cancel(); } catch { /* ignore */ }
      }
      return raw;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: fake ? 'fake' : 'server',
    modelId: fake ? 'fake' : 'qwen3-8b',
    async init(onProgress = () => {}) {
      if (fake) {
        const { CreateFakeEngine } = await import('./fake-engine.js');
        engine = await CreateFakeEngine('fake', { initProgressCallback: (r) => onProgress({ progress: r.progress ?? 0, text: r.text || '' }) }, { context_window_size: CONTEXT_WINDOW });
        return;
      }
      if (location.protocol === 'file:') throw new Error(NO_SERVER_MSG);
      const t0 = Date.now();
      let failures = 0;
      onProgress({ progress: 0.02, text: '連線到本機模型伺服器…' });
      for (;;) {
        let status = 0;
        try {
          const res = await fetch(apiUrl('health'), { cache: 'no-store' });
          status = res.status;
          if (res.ok) {
            let j = null;
            try { j = await res.json(); } catch { /* ignore */ }
            if (!j || j.status === 'ok') { onProgress({ progress: 1, text: '模型已就緒' }); return; }
          }
          failures = 0;
        } catch {
          failures++;
        }
        if (failures >= 5) throw new Error(NO_SERVER_MSG);
        if (status && status !== 503) throw new Error(`模型伺服器狀態異常 (HTTP ${status})`);
        const secs = (Date.now() - t0) / 1000;
        if (secs > 600) throw new Error('模型載入逾時（超過 10 分鐘）。請查看 logs 資料夾內的記錄。');
        onProgress({ progress: Math.min(0.95, 0.05 + 0.9 * (1 - Math.exp(-secs / 25))), text: `模型載入中…（已等待 ${Math.round(secs)} 秒）` });
        await sleep(1000);
      }
    },
    // onToken(visibleTextSoFar) is called while streaming. Returns the final, think-stripped text.
    async chat(messages, { temperature = 0.8, max_tokens = 200, top_p = 0.9, onToken } = {}) {
      const fitted = fitMessages(messages, max_tokens);
      if (fake) {
        if (!engine) throw new Error('模型尚未載入');
        const out = await engine.chat.completions.create({ messages: fitted, temperature, top_p, max_tokens, stream: false });
        const text = stripThink(out.choices?.[0]?.message?.content || '').trim();
        if (text) onToken?.(text);
        return text;
      }
      const raw = await post(body(fitted, { temperature, max_tokens, top_p, stream: true }), { onText: onToken });
      return stripThink(raw).trim();
    },
    async judge({ occupation, candidate }) {
      if (!candidate) return { is_guess: false, correct: false };
      const fitted = fitMessages(buildJudgeMessages(occupation, candidate), 8);
      let raw;
      if (fake) {
        if (!engine) throw new Error('模型尚未載入');
        const out = await engine.chat.completions.create({ messages: fitted, temperature: 0, max_tokens: 8, stream: false });
        raw = out.choices?.[0]?.message?.content || '';
      } else {
        raw = await post(body(fitted, { temperature: 0, max_tokens: 8, top_p: 1, stream: false }), { firstByteMs: 120000 });
      }
      return { is_guess: true, correct: parseYesNo(stripThink(raw).trim()) };
    },
  };
}

// ---------- mock ----------
function createMockLLM() {
  let turn = 0;
  return {
    kind: 'mock',
    modelId: 'mock',
    async init(onProgress = () => {}) {
      for (const p of [0.3, 0.7, 1]) {
        onProgress({ progress: p, text: `模擬模式，不需下載模型 (${Math.round(p * 100)}%)` });
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async chat(messages, { persona } = {}) {
      turn++;
      const last = messages[messages.length - 1]?.content || '';
      return mockReply(persona, last, turn);
    },
    async judge({ occupation, candidate }) {
      // Not permissive: only confirms when the candidate really overlaps the title.
      if (!candidate) return { is_guess: false, correct: false };
      const m = matchCandidate(candidate, occupation);
      return { is_guess: true, correct: m.verdict === 'correct' || (m.verdict === 'borderline' && m.score >= 0.7) };
    },
  };
}

function mockReply(persona, userText, n) {
  if (!persona) return '嗯，今天的酒不錯。';
  const { info, traits, occupation: occ } = persona;
  const tools = occ.tools || [];
  const hobby = traits.hobbies?.[0]?.hobby || '散步';
  const habit = traits.habits?.[0]?.habit || '早點睡';
  const phrase = traits.catchphrases?.[0]?.phrase || '';
  const task = occ.responsibilities?.[0]?.task || '處理各種事情';
  const food = traits.favorite_foods?.[0]?.food || '熱湯麵';
  const lines = [
    `嗯，今天好累，我平常的習慣是${habit}，不過今晚想放鬆一下。${phrase}`,
    `${tools[0] ? `我每天都會用到${tools[0]}。` : '我每天都有固定的工具。'}你呢，調酒要用哪些工具？`,
    `休假時我喜歡${hobby}，配一杯酒剛剛好。`,
    `上班時最常做的就是「${task}」這類的事，說多了就露餡了。`,
    `${tools[1] ? `${tools[1]}，是我身邊少不了的東西。` : '工作上的東西很雜。'}對了，有吃的嗎？我最愛${food}。`,
  ];
  let reply = lines[(n - 1) % lines.length];
  if (/酒|喝|杯/.test(userText)) reply = `這杯不錯！${reply}`;
  return reply;
}
