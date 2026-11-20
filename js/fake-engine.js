// Dev-only stub (?fake=1) mimicking @mlc-ai/web-llm 0.2.79's MLCEngine API surface and its
// request validation, so the non-mock control path can be exercised without a GPU.
// Errors/messages copied from web-llm: SystemMessageOrderError, MessageOrderError,
// ContextWindowSizeExceededError, MinValueError, "engine not loaded".
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const tokens = (s) => { let n = 0; for (const ch of String(s)) n += ch.charCodeAt(0) > 0x7f ? 1 : 0.3; return Math.ceil(n); };

function err(name, message) { const e = new Error(message); e.name = name; return e; }

export async function CreateFakeEngine(modelId, engineConfig = {}, chatOpts = {}) {
  const ctx = chatOpts.context_window_size || 4096;
  const report = engineConfig.initProgressCallback || (() => {});
  for (const p of [0.2, 0.6, 1]) { report({ progress: p, text: `Fake engine loading ${Math.round(p * 100)}%` }); await delay(15); }

  let locked = false;
  const waiters = [];
  const acquire = () => new Promise((res) => { if (!locked) { locked = true; res(); } else waiters.push(res); });
  const release = () => { const n = waiters.shift(); if (n) n(); else locked = false; };
  let filledKV = 0;
  let lastConv = null; // [{role,content}] incl. reply, like web-llm's multiround detection
  let calls = 0;

  async function create(req) {
    if (!req || !Array.isArray(req.messages) || !req.messages.length) throw err('Error', 'messages required');
    req.messages.forEach((m, i) => {
      if (typeof m.content !== 'string') throw err('ContentTypeError', `${m.role} should have string content.`);
      if (m.role === 'system' && i !== 0) throw err('SystemMessageOrderError', 'System prompt should always be the first message in `messages`.');
    });
    const last = req.messages[req.messages.length - 1];
    if (last.role !== 'user' && last.role !== 'tool') throw err('MessageOrderError', 'Last message should be from either `user` or `tool`.');
    if (req.max_tokens !== undefined && req.max_tokens <= 0) throw err('MinValueError', 'Provided max_tokens needs to be at least larger than 0.');
    if (req.stream) throw err('Error', 'fake engine: stream not implemented');
    await acquire();
    try {
      calls++;
      const prior = req.messages.slice(0, -1);
      const same = lastConv && lastConv.length === prior.length && lastConv.every((m, i) => m.role === prior[i].role && m.content === prior[i].content);
      if (!same) filledKV = 0; // web-llm resets the KV cache when the conversation differs
      const promptTok = tokens(last.content) + (same ? 0 : prior.reduce((n, m) => n + tokens(m.content), 0)) + 6;
      if (promptTok + filledKV > ctx) {
        throw err('ContextWindowSizeExceededError', `Prompt tokens exceed context window size: number of prompt tokens: ${promptTok}; context window size: ${ctx}\nConsider shortening the prompt, or increase \`context_window_size\`, or using sliding window via \`sliding_window_size\`.`);
      }
      await delay(40 + Math.random() * 60);
      if (new URLSearchParams(location.search).get('crash') === '1') { location.reload(); await delay(60000); } // simulate tab killed mid-generation
      const sys = req.messages[0].role === 'system' ? req.messages[0].content : '';
      let reply;
      if (sys.includes('遊戲裁判')) {
        const guess = /是不是|是.{1,8}嗎|你是.{1,10}吧|猜/.test(last.content);
        reply = JSON.stringify({ is_guess: guess, correct: false });
      } else {
        reply = ['嗯，今天真的有點累，先來杯威士忌吧。', '工作上的事情說不完，反正每天都很忙。', '休假的時候我只想睡到自然醒。', '這杯酒不錯，你調的？', '我常常要盯著一堆東西看，眼睛都花了。'][calls % 5];
      }
      const completion = Math.min(tokens(reply), req.max_tokens ?? Infinity);
      filledKV = (same ? filledKV : 0) + promptTok + completion;
      lastConv = [...prior, last, { role: 'assistant', content: reply }];
      return { id: `fake-${calls}`, object: 'chat.completion', model: modelId, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply } }], usage: { prompt_tokens: promptTok, completion_tokens: completion, total_tokens: promptTok + completion } };
    } finally { release(); }
  }

  return {
    chat: { completions: { create } },
    async resetChat() { await acquire(); try { filledKV = 0; lastConv = null; } finally { release(); } },
    async interruptGenerate() {},
  };
}
