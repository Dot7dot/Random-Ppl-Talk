// On-device LLM (WebLLM, WebGPU) with a mock backend for ?mock=1.
import { buildJudgeMessages } from './prompt.js';
import { parseYesNo, matchCandidate } from './rules.js';

export const WEBLLM_VERSION = '0.2.79';
export const WEBLLM_URL = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/+esm`;
export const CONTEXT_WINDOW = 4096;

export const MODELS = [
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 1.5B（建議，約 1GB）' },
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 0.5B（輕量，適合較舊手機）' },
];

export async function checkWebGPU() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return { ok: false, reason: '此瀏覽器不支援 WebGPU。請改用較新的 Chrome / Edge（Android 12+）或 iOS 18+ 的 Safari，或在網址後加上 ?mock=1 試玩模擬模式。' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: '找不到可用的 GPU 介面卡（WebGPU adapter）。請確認裝置與瀏覽器支援 WebGPU。' };
    const l = adapter.limits || {};
    const low = (l.maxBufferSize && l.maxBufferSize < LOW_LIMIT) || (l.maxStorageBufferBindingSize && l.maxStorageBufferBindingSize < LOW_LIMIT);
    return { ok: true, lowMemory: !!low };
  } catch (e) {
    return { ok: false, reason: `WebGPU 初始化失敗：${e?.message || e}` };
  }
}

const LOW_LIMIT = 1024 * 1024 * 1024; // adapter buffer limits below ~1GB: prefer the 0.5B model
export const LIGHT_MODEL = MODELS[1].id;

export function isMobileDevice() {
  try {
    if (navigator.userAgentData?.mobile) return true;
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')) return true;
    return navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 820;
  } catch { return false; }
}

// Web-llm unloads the engine when the GPU device is lost (usually OOM); later calls throw these.
export const isDeviceLostError = (e) => /DeviceLost|device was lost|not loaded|before calling chat|MLCEngine\.reload/i.test(`${e?.name} ${e?.message}`);

export function createLLM({ mock = false, fake = false, modelId = MODELS[0].id } = {}) {
  const llm = mock ? createMockLLM() : createWebLLM(modelId, { fake });
  return serialize(llm);
}

// One generation at a time per engine (judge + chat must never overlap).
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
  return Math.ceil(n) + 4; // + per-message template overhead is added by callers
}
const MSG_OVERHEAD = 8;
export const promptTokens = (messages) => messages.reduce((n, m) => n + estimateTokens(m.content) + MSG_OVERHEAD, 6);

// web-llm requires: system only first, last message from user. Also merge same-role
// neighbours and drop a leading assistant so the template stays well-formed, then drop
// oldest turns (and finally clip the system prompt) until the prompt fits the window.
export function fitMessages(messages, maxTokens = 160, ctx = CONTEXT_WINDOW) {
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

const withTimeout = (p, ms, onTimeout) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { try { onTimeout?.(); } catch { /* ignore */ } reject(new Error('模型回應逾時')); }, ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

function createWebLLM(modelId, { fake = false } = {}) {
  let engine = null;
  return {
    kind: fake ? 'fake' : 'webllm',
    modelId,
    async init(onProgress = () => {}) {
      if (fake) {
        const { CreateFakeEngine } = await import('./fake-engine.js');
        engine = await CreateFakeEngine(modelId, { initProgressCallback: (r) => onProgress({ progress: r.progress ?? 0, text: r.text || '' }) }, { context_window_size: CONTEXT_WINDOW });
        return;
      }
      const gpu = await checkWebGPU();
      if (!gpu.ok) throw new Error(gpu.reason);
      onProgress({ progress: 0, text: '載入 WebLLM 程式庫…' });
      const webllm = await import(/* @vite-ignore */ WEBLLM_URL);
      engine = await webllm.CreateMLCEngine(
        modelId,
        { initProgressCallback: (r) => onProgress({ progress: r.progress ?? 0, text: r.text || '' }) },
        { context_window_size: CONTEXT_WINDOW },
      );
    },
    async chat(messages, { temperature = 0.8, max_tokens = 160, top_p = 0.9 } = {}) {
      if (!engine) throw new Error('模型尚未載入');
      const fitted = fitMessages(messages, max_tokens);
      // Fresh KV cache every call: prompts differ (judge vs chat), never rely on prefix reuse.
      try { await engine.resetChat?.(); } catch (e) { console.warn('resetChat failed', e); }
      let out;
      try {
        out = await withTimeout(
        engine.chat.completions.create({
          messages: fitted, temperature, top_p, max_tokens, stream: false,
          frequency_penalty: 0.3,
        }),
        90000,
        () => engine.interruptGenerate?.(),
        );
      } catch (e) {
        if (isDeviceLostError(e)) { const d = new Error('GPU 裝置已中斷（多半是記憶體不足）'); d.name = 'DeviceLostError'; d.deviceLost = true; engine = null; throw d; }
        throw e;
      }
      return (out.choices?.[0]?.message?.content || '').trim();
    },
    async judge({ occupation, candidate }) {
      if (!candidate) return { is_guess: false, correct: false };
      const raw = await this.chat(buildJudgeMessages(occupation, candidate), { temperature: 0, max_tokens: 4 });
      return { is_guess: true, correct: parseYesNo(raw) };
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
