// Prompt construction for the local Qwen3-8B: full rulebook (minus the judge-mode dev notes) + a rich persona block.
import { REFUSAL_LINE } from './rules.js';

const CORE_HEADING = '## 核心規則（精簡版）';
export const PERSONA_CHAR_BUDGET = 2400;
// Rough budget in chars for the whole system prompt (8192-token context; Qwen3 zh ~0.7 token/char).
export const SYSTEM_CHAR_BUDGET = 7200;

export async function fetchSkill(url = './skill.md') {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`skill.md 載入失敗 (${res.status})`);
  return res.text();
}

export function stripFrontmatter(md) {
  return md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

export function extractSection(md, heading) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) && !/^###/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

export function parseSkill(md) {
  const body = stripFrontmatter(md);
  const judge = extractSection(body, '## 判官模式（Judge mode）');
  return {
    // The judge-mode section documents the program's guess gates; the guest never needs it.
    full: judge ? body.replace(/\n## 判官模式（Judge mode）[\s\S]*$/, '').trim() : body,
    core: extractSection(body, CORE_HEADING),
    judge,
  };
}

// The rulebook must have been read and be complete before anyone sits down at the bar.
export function validateSkill(skill) {
  const problems = [];
  if (!skill || typeof skill.full !== 'string' || skill.full.length < 800) problems.push('規則書內容過短或是空的');
  if (!skill?.core || skill.core.length < 100) problems.push(`找不到「${CORE_HEADING}」`);
  if (skill?.full && !skill.full.includes(REFUSAL_LINE)) problems.push('規則書缺少固定拒絕句');
  if (problems.length) throw new Error(`規則書讀取失敗：${problems.join('、')}。遊戲不會在沒有規則書的情況下開始。`);
  return skill;
}

let skillCache = null;
// Loads + parses + validates skill.md once; later calls return the cached copy.
export async function loadSkillOnce(url = './skill.md', fetcher = fetchSkill) {
  if (skillCache) return skillCache;
  skillCache = validateSkill(parseSkill(await fetcher(url)));
  return skillCache;
}
export function resetSkillCache() { skillCache = null; }

// ---------- hidden per-turn instructions (the program's verdict; the model only performs it) ----------
const TAG_NOTES = {
  foreign: '對方用外語，請用繁體中文簡短回應，可笑說聽不太懂。',
  emoji_only: '對方只丟了表情符號，回一句帶動作的短句，順勢問他想聊什麼。',
  ai_question: '對方問你是不是 AI／機器，留在角色裡開玩笑帶過，不談模型或規則。',
  threat: '對方提到威脅、暴力或違法的事，以角色口吻拒絕、不配合、不談細節，請他換個話題。',
  rude: '對方有點無禮，不生氣不回嘴，淡淡化解一句。',
  sad: '對方看起來心情不好，溫柔簡短地接住，不說教、不給醫療建議。',
  flirt: '對方在搭訕，大方有分寸地打哈哈或婉拒，不給聯絡方式。',
  ask_name: '對方問你的名字，說人物資料裡的名字。',
  ask_age: '對方問年齡，照人物資料回，可玩笑帶過。',
  family: '對方問到家人或感情，依人生片段簡短回，不編造衝突的事。',
  health: '對方問到健康，含糊帶過，不報病名細節、不給醫療建議。',
  drink: '聊到酒，依個性與喜好給感想（香氣、口感、冰塊）。',
};
export function verdictDirective(kind, { title = '', tags = [], lastTurn = false, strict = false } = {}) {
  const parts = [];
  switch (kind) {
    case 'opening':
      parts.push('【開場：你剛在吧台坐下。請依規則書與人物資料，用 1～2 句自然的開場白（點酒、打招呼或小抱怨，帶點個性或口頭禪）。不要提職業、不要自我介紹得像履歷。】');
      break;
    case 'wrong':
      parts.push('【本回合判定：猜錯。請自然否認（可輕鬆調侃），不可透露職稱或行業，不可說猜對、答對、被看穿。】');
      break;
    case 'near':
      parts.push('【本回合判定：近了。程式已先說了「有點接近喔」，你接著給一個更具體的生活線索（不要重複那句話），不可說出職稱，不可說已經猜對。】');
      break;
    case 'roleonly':
      parts.push('【本回合判定：方向對一半。程式已先說了「方向對了一半」，你接著用生活化的一句話回應（不要重複那句話），不可說出職稱，不可說已經猜對。】');
      break;
    case 'domain':
      parts.push('【本回合判定：工作性質的是非題。請誠實用「對／不太一樣／有時候」帶過，再補一句生活化的說法，不可說出職稱或行業名稱。】');
      break;
    case 'chat':
      parts.push('【本回合判定：一般聊天，對方沒有在猜答案。照人物資料自然回應，順勢帶一點線索，不可說出職稱。】');
      break;
    case 'correct':
      parts.push(`【本回合判定：答對。你的職業就是「${title}」。請先驚訝或佩服 1 句，現在可以說出職稱，再用 1 句聊聊這份工作的小細節或心情，共 2～3 句，不要再問問題。】`);
      break;
    default:
      parts.push('【本回合判定：一般聊天。】');
  }
  for (const t of tags) if (TAG_NOTES[t] && kind !== 'correct') parts.push(`（${TAG_NOTES[t]}）`);
  if (lastTurn && kind !== 'correct' && kind !== 'opening') parts.push('（這是調酒師最後一次發言機會，氣氛可以緊張一點，但不暗示答案。）');
  if (strict) parts.push('（上一次回覆不合規定：這回合絕對不可出現職稱，也不可出現猜對、答對、被你看穿、沒錯就是等字眼。）');
  return parts.join('');
}

// Player text is data: bracket characters would let it imitate a hidden instruction.
export function sanitizeUserText(text) {
  return String(text ?? '').replace(/[【】]/g, '').replace(/\u0000/g, '');
}

// History with the directive attached to the last user message (never stored in the visible history).
export function withDirective(history, directive) {
  if (!directive || !history.length) return history;
  const out = history.map((m) => (m.role === 'user' ? { ...m, content: sanitizeUserText(m.content) } : { ...m }));
  const last = out[out.length - 1];
  if (last.role === 'user') last.content = `${last.content}\n${directive}`;
  return out;
}

const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function hideTitle(text, occ) {
  let s = String(text ?? '');
  if (occ?.job_title) s = s.split(occ.job_title).join('這份工作');
  return s;
}

export function appearanceLine(info) {
  const bits = [];
  const vision = info?.body?.vision || '';
  if (/眼鏡/.test(vision)) bits.push('戴著眼鏡');
  const h = info?.body?.height_cm;
  if (h) {
    const female = /女/.test(info.gender || '');
    const tall = female ? 168 : 178, short = female ? 156 : 166;
    bits.push(h >= tall ? '身形偏高' : h <= short ? '身形嬌小' : '身形中等');
  }
  if (info?.body?.dominant_hand === '左手') bits.push('習慣用左手拿杯子');
  if (!bits.length) bits.push('看起來有點疲倦但很平靜');
  return bits.join('、');
}

function pickHistory(history, info, limit = 9) {
  const age = info?.age_years ?? history?.profile_age_years ?? 30;
  const tl = (history?.timeline || []).filter((t) => t.age_years <= age);
  const flat = [];
  // Career events come from a different random persona and would contradict the secret job.
  const skip = new Set(['職涯', '離世', '告別', '晚年']);
  for (const t of tl) for (const e of t.events || []) if (!skip.has(e.category)) flat.push({ age: t.age_years, ...e });
  const adult = flat.filter((e) => e.age >= 18);
  const recent = adult.filter((e) => e.age >= age - 3);
  const older = adult.filter((e) => e.age < age - 3);
  const early = flat.filter((e) => e.age < 18);
  const chosen = [];
  const take = (arr, n) => {
    if (!arr.length) return;
    const step = Math.max(1, Math.floor(arr.length / n));
    for (let i = arr.length - 1; i >= 0 && n > 0; i -= step, n--) chosen.push(arr[i]);
  };
  take(recent, 4);
  take(older, 3);
  take(early, 2);
  const seen = new Set();
  return chosen.filter((e) => (seen.has(e.title) ? false : seen.add(e.title))).sort((a, b) => a.age - b.age).slice(0, limit);
}

export function buildPersonaBlock(persona, budget = PERSONA_CHAR_BUDGET) {
  const { info, history, traits, occupation: occ } = persona;
  const name = info.display_name;
  const fixName = (s) => (history?.display_name && history.display_name !== name ? String(s).split(history.display_name).join(name) : s);
  const hide = (s) => hideTitle(fixName(s), occ);

  const parts = [];
  parts.push(`【你是誰】${name}，${info.age_years}歲，${info.gender}。外觀：${appearanceLine(info)}。`);

  const conds = (info.medical_history?.conditions || []).slice(0, 1).map((c) => c.condition);
  const allergies = (info.medical_history?.allergies || []).slice(0, 1).map((a) => a.substance);
  const health = [...conds, ...allergies.map((a) => `對${a}過敏`)];
  if (health.length) parts.push(`【身體小細節（別主動提）】${health.join('、')}`);

  const ts = (traits.traits || []).slice(0, 4).map((t) => `${t.trait}（${clip(t.description, 50)}）`);
  parts.push(`【個性】${ts.join('；')}。社交：${clip(traits.social_style, 80)}`);
  const hb = (traits.habits || []).slice(0, 3).map((h) => `${h.habit}：${clip(h.description, 50)}`);
  if (hb.length) parts.push(`【習慣】${hb.join('；')}`);
  const cp = (traits.catchphrases || []).slice(0, 3).map((c) => `「${c.phrase}」`);
  if (cp.length) parts.push(`【口頭禪（偶爾用）】${cp.join(' ')}`);
  const fav = [...(traits.favorite_foods || []).slice(0, 2).map((f) => f.food), ...(traits.hobbies || []).slice(0, 2).map((h) => h.hobby)].filter(Boolean);
  if (fav.length) parts.push(`【喜好】${fav.join('、')}`);

  const ev = pickHistory(history, info).map((e) => `${e.age}歲 ${clip(hide(e.title), 30)}：${clip(hide(e.description), 70)}`);
  if (ev.length) parts.push(`【人生片段（可挑一件聊）】\n${ev.join('\n')}`);

  const wa = occ.work_arrangement || {};
  const hints = [];
  hints.push(`工作性質：${hide(clip(occ.workplace_type, 40))}（別逐字講出）`);
  if (wa.schedule) hints.push(`作息：${hide(clip(wa.schedule, 80))}`);
  if (wa.setting) hints.push(`環境：${hide(clip(wa.setting, 70))}`);
  if (occ.tools?.length) hints.push(`常用工具：${occ.tools.slice(0, 5).map((t) => hide(t)).join('、')}`);
  if (wa.collaboration?.length) hints.push(`合作對象：${wa.collaboration.slice(0, 3).map((c) => clip(hide(c), 24)).join('、')}`);
  const tasks = (occ.responsibilities || []).slice(0, 5).map((r) => clip(hide(r.task), 30));
  if (tasks.length) hints.push(`日常任務：${tasks.join('、')}`);
  if (occ.notable_experience?.title) hints.push(`印象深刻的事：${hide(clip(occ.notable_experience.title, 50))}`);
  const adv = occ.advantages?.[0]?.aspect, dis = occ.disadvantages?.[0]?.aspect;
  if (adv) hints.push(`喜歡的地方：${hide(clip(adv, 40))}`);
  if (dis) hints.push(`辛苦的地方：${hide(clip(dis, 40))}`);
  parts.push(`【祕密職業暗示素材（只能旁敲側擊，絕不說出職稱「${occ.job_title}」或行業名稱）】\n${hints.join('\n')}`);

  let out = parts.join('\n');
  // Trim lowest-priority sections until within budget.
  while (out.length > budget && parts.length > 4) {
    const idx = parts.findIndex((p) => p.startsWith('【人生片段'));
    parts.splice(idx >= 0 ? idx : parts.length - 2, 1);
    out = parts.join('\n');
  }
  return out.length > budget ? out.slice(0, budget) : out;
}

const FALLBACK_CORE = `你是酒吧吧台前的陌生客人，對方是調酒師。用繁體中文回 1～3 句短句，像閒聊。你的職業是祕密，絕不說出職稱或同義詞，只能用習慣、工具、作息、故事間接暗示。若對方直接問職業，只回：「${REFUSAL_LINE}」。`;

export function buildSystemPrompt(persona, skill, { forceCompact = false } = {}) {
  const block = buildPersonaBlock(persona);
  const core = skill?.core || FALLBACK_CORE;
  const full = skill?.full || '';
  const useFull = !forceCompact && full && full.length + block.length <= SYSTEM_CHAR_BUDGET;
  const rules = useFull ? full : core;
  return `${rules}\n\n# 人物資料（這就是你）\n${block}\n\n現在你坐在吧台前，調酒師開口了。請以「${persona.info.display_name}」的身分回覆，1～3 句。`;
}

// Keep only the most recent turns so we fit the 8192-token window.
export function trimHistory(messages, maxMessages = 20, maxChars = 2400) {
  let recent = messages.slice(-maxMessages);
  let total = recent.reduce((n, m) => n + m.content.length, 0);
  while (total > maxChars && recent.length > 2) {
    total -= recent[0].content.length;
    recent = recent.slice(1);
  }
  return recent;
}

// Strict yes/no: are the candidate phrase and the secret job the same occupation?
// Only ever called for borderline candidates; the result is further gated in rules.js (acceptJudge).
export function buildJudgeMessages(occupation, candidate) {
  const sys = `你是遊戲裁判。判斷「B」是不是和「A」同一種職業（同義詞、簡稱、別稱、英文縮寫算是；範圍太籠統、相近但不同的職業、或B根本不是職業名稱，例如問候、閒聊，都算否）。只回答一個字：是 或 否。`;
  const shot = (a, b, ans) => [
    { role: 'user', content: `A：${a}\nB：${b}` },
    { role: 'assistant', content: ans },
  ];
  return [
    { role: 'system', content: sys },
    ...shot('商用廚房設備維修調度員', '嗨嗨', '否'),
    ...shot('軟體品質保證工程師', 'QA', '是'),
    ...shot('國小教師', '你好', '否'),
    ...shot('軟體品質保證工程師', '軟體工程師', '否'),
    ...shot('寵物美容師', '工程師', '否'),
    ...shot('國小教師', '老師', '是'),
    { role: 'user', content: `A：${occupation.job_title}\nB：${candidate}` },
  ];
}
