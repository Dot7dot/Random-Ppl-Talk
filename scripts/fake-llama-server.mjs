#!/usr/bin/env node
// Fake llama-server for local testing on any OS (Node 18+, no dependencies).
//
// Mimics the parts of llama.cpp's `llama-server` that the game uses:
//   - static files from --path (the game is served from the same origin)
//   - GET /health (503 while "loading", then 200)
//   - POST /v1/chat/completions (OpenAI format, stream and non-stream)
//   - GET /v1/models
//
// Usage:
//   node scripts/fake-llama-server.mjs --path . --port 8080 [--loading-ms 3000] [--think] [--judge-yes]
//
// Not a real model: replies are canned Chinese lines, and judge requests
// (system prompt containing "是 或 否", "只回答一個字", "判定" or "judge")
// get "否" (or "是" with --judge-yes).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MODEL_ID = 'qwen3-8b-fake';

const CANNED = [
  '嗯，今天好累，我平常的習慣是下班後喝一杯，不過今晚想放鬆一下。',
  '上班時最常做的就是那些例行的事，說多了就露餡了。',
  '工作上的東西很雜，有時候一整天都在跟人打交道。對了，有吃的嗎？',
  '你問這個啊？我比較想聊聊最近看的電影，你有推薦的嗎？',
  '哈哈，你還真會問。我這人啊，週末通常是睡到自然醒。',
  '說到這個，我以前住在南部，後來才搬到這裡來的。',
];

// ---------- argument parsing ----------

function parseArgs(argv) {
  const opts = { path: '.', port: 8080, loadingMs: 0, think: false, judgeYes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--path': opts.path = next(); break;
      case '--port': opts.port = Number(next()); break;
      case '--loading-ms': opts.loadingMs = Number(next()); break;
      case '--think': opts.think = true; break;
      case '--judge-yes': opts.judgeYes = true; break;
      case '-h':
      case '--help':
        console.log('usage: node scripts/fake-llama-server.mjs --path . --port 8080 [--loading-ms 3000] [--think] [--judge-yes]');
        process.exit(0);
        break;
      default:
        die(`unknown argument: ${a}`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) die('invalid --port');
  if (!Number.isFinite(opts.loadingMs) || opts.loadingMs < 0) die('invalid --loading-ms');
  return opts;
}

function die(msg) {
  console.error(`[fake-llama] ${msg}`);
  process.exit(2);
}

const opts = parseArgs(process.argv.slice(2));
const root = path.resolve(opts.path);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`--path is not a directory: ${root}`);
const startedAt = Date.now();
let counter = 0;

// ---------- helpers ----------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function apiError(res, status, message, type) {
  sendJson(res, status, { error: { code: status, message, type } });
}

function isLoading() {
  return Date.now() - startedAt < opts.loadingMs;
}

function isJudgeRequest(messages) {
  // Only the dedicated judge prompt counts. (The game rulebook and the hidden 【本回合判定：…】 turn
  // directive also contain the word 判定, so that word must not trigger judge mode.)
  const systemText = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n');
  return /遊戲裁判/.test(systemText) || (/是\s*或\s*否/.test(systemText) && /只回答一個字/.test(systemText));
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && p.text) || '').join('');
  return '';
}

function buildReply(messages) {
  let text;
  if (isJudgeRequest(messages)) {
    text = opts.judgeYes ? '是' : '否';
  } else {
    const last = textOf(messages[messages.length - 1].content);
    if (/本回合判定：答對/.test(last)) text = '（愣住後笑了）哇，被你猜中了，真的假的？';
    else if (/【開場/.test(last)) text = '（坐下）晚安，今天想來杯威士忌。';
    else text = CANNED[counter % CANNED.length];
  }
  if (opts.think) text = `<think>這是思考內容</think>${text}`;
  return text;
}

// Rough token estimate, good enough for the usage block.
function estimateTokens(s) {
  return Math.max(1, Math.ceil(String(s).length / 2));
}

function validateChatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'request body must be a JSON object';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages must be a non-empty array';
  for (const m of body.messages) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') return 'each message needs a role';
  }
  const last = body.messages[body.messages.length - 1];
  if (last.role !== 'user') return 'last message must have role "user"';
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- handlers ----------

function handleHealth(res) {
  if (isLoading()) {
    sendJson(res, 503, { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } });
  } else {
    sendJson(res, 200, { status: 'ok' });
  }
}

function handleModels(res) {
  sendJson(res, 200, {
    object: 'list',
    data: [{ id: MODEL_ID, object: 'model', created: Math.floor(startedAt / 1000), owned_by: 'llamacpp' }],
  });
}

async function handleChat(req, res) {
  if (isLoading()) {
    apiError(res, 503, 'Loading model', 'unavailable_error');
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    apiError(res, 400, `invalid JSON: ${e.message}`, 'invalid_request_error');
    return;
  }
  const problem = validateChatBody(body);
  if (problem) {
    apiError(res, 400, problem, 'invalid_request_error');
    return;
  }

  counter++;
  const id = `chatcmpl-fake-${counter}`;
  const created = Math.floor(Date.now() / 1000);
  const reply = buildReply(body.messages);
  const promptTokens = body.messages.reduce((n, m) => n + estimateTokens(textOf(m.content)), 0);
  const completionTokens = estimateTokens(reply);
  const judge = isJudgeRequest(body.messages);
  const lastUser = textOf(body.messages[body.messages.length - 1].content).slice(0, 30).replace(/\s+/g, ' ');
  console.log(`[fake-llama] chat #${counter} stream=${!!body.stream} judge=${judge} -> ${JSON.stringify(reply)}  (last user: "${lastUser}")`);

  if (!body.stream) {
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: reply },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: MODEL_ID,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  // Split into small pieces (2 chars each) to exercise client-side accumulation.
  const pieces = [];
  const chars = Array.from(reply);
  for (let i = 0; i < chars.length; i += 2) pieces.push(chars.slice(i, i + 2).join(''));

  let aborted = false;
  res.on('close', () => { aborted = true; });
  for (const piece of pieces) {
    if (aborted) return;
    res.write(chunk({ content: piece }, null));
    await sleep(30);
  }
  if (!aborted) {
    res.write(chunk({}, 'stop'));
    res.write('data: [DONE]\n\n');
  }
  res.end();
}

// ---------- static files ----------

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  // Resolve inside root and refuse anything that escapes it (path traversal).
  const target = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(target).pipe(res);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;
  const started = Date.now();
  res.on('finish', () => {
    if (!pathname.startsWith('/v1/chat/')) {
      console.log(`[fake-llama] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  try {
    if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      return handleHealth(res);
    }
    if (pathname === '/v1/models' && req.method === 'GET') {
      return handleModels(res);
    }
    if (pathname === '/v1/chat/completions') {
      if (req.method !== 'POST') return apiError(res, 405, 'use POST', 'invalid_request_error');
      return await handleChat(req, res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  } catch (e) {
    console.error('[fake-llama] handler error:', e);
    if (!res.headersSent) apiError(res, 500, String(e && e.message), 'server_error');
    else res.end();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[fake-llama] port ${opts.port} is already in use. Pick another with --port.`);
  } else {
    console.error('[fake-llama] server error:', e);
  }
  process.exit(1);
});

server.listen(opts.port, '127.0.0.1', () => {
  const dir = path.relative(process.cwd(), root) || '.';
  console.log(`[fake-llama] listening on http://127.0.0.1:${opts.port}/`);
  console.log(`[fake-llama] static root: ${dir}`);
  console.log(`[fake-llama] loading-ms=${opts.loadingMs} think=${opts.think} judge-yes=${opts.judgeYes}`);
  console.log(`[fake-llama] open http://127.0.0.1:${opts.port}/  (add ?mock=1 for mock mode)`);
});

// Quiet exit on Ctrl+C.
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
