// On-device LLM (WebLLM, WebGPU) with a mock backend for ?mock=1.
import { buildJudgeMessages } from './prompt.js';
import { parseJudge, deterministicGuess } from './rules.js';

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
  } catch (e) {
    return { ok: false, reason: `WebGPU 初始化失敗：${e?.message || e}` };
  }
  return { ok: true };
}

export function createLLM({ mock = false, modelId = MODELS[0].id } = {}) {
  return mock ? createMockLLM() : createWebLLM(modelId);
}

function createWebLLM(modelId) {
  let engine = null;
  return {
    kind: 'webllm',
    modelId,
    async init(onProgress = () => {}) {
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
      const out = await engine.chat.completions.create({
        messages, temperature, top_p, max_tokens, stream: false,
        frequency_penalty: 0.3,
      });
      return (out.choices?.[0]?.message?.content || '').trim();
    },
    async judge({ occupation, text }) {
      const raw = await this.chat(buildJudgeMessages(occupation, text), { temperature: 0, max_tokens: 40 });
      return parseJudge(raw);
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
    async judge({ occupation, text }) {
      const correct = deterministicGuess(text, occupation);
      const is_guess = correct || /是不是|是.{1,8}嗎|你是.{1,10}吧|猜/.test(text);
      return { is_guess, correct };
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
