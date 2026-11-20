// Deterministic game rules: turn formula, direct-question detection, guess matching, leak check.

export const REFUSAL_LINE = '不可以問這個喔！這樣就不好玩了';

export function turnsForLevel(level) {
  const l = Math.max(1, Math.floor(Number(level) || 1));
  return Math.max(3, 10 - Math.floor((l - 1) / 5));
}

export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/臺/g, '台')
    .replace(/[\s　]+/g, '')
    .replace(/[.,!?;:'"`~()\[\]{}<>\/\\|_\-+=*&^%$#@，。！？；：、「」『』（）【】《》〈〉…—～·]/g, '');
}

// ---------- direct "what is your job" detector ----------
const WHAT = '(?:什麼|甚麼|啥|哪|何|啥麼|怎樣的|哪種|哪個|哪一)';
const DIRECT_PATTERNS = [
  // 你的職業是什麼 / 你的工作是啥 / 你職業是甚麼 / 請問你的職稱為何
  new RegExp(`(?:你|妳|您|閣下).{0,3}(?:職業|職稱|職位|職務|本業|行業|工作)(?:是|為|叫|算是|屬於)?${WHAT}`),
  new RegExp(`(?:你|妳|您).{0,3}(?:職業|職稱|職務|本業)(?:是|為)?(?:何|什麼|啥)`),
  // 你做什麼工作 / 你是做什麼的 / 你在做什麼行業 / 你從事什麼工作 / 你幹嘛的
  new RegExp(`(?:你|妳|您)(?:是|現在|目前|平常|平時|主要|到底|究竟|都|都是|在|是在)*(?:做|從事|幹|搞|負責)${WHAT}(?:工作|行業|職業|行|業|領域|的|生意|職務|類型的工作)`),
  new RegExp(`(?:你|妳|您)(?:是|到底是|究竟是)?(?:幹嘛|幹嘛|幹什麼|做什麼|做啥|幹啥)的`),
  // 你是哪一行的 / 你哪行的 / 你是做哪行的
  new RegExp(`(?:你|妳|您)(?:是|在)?(?:做|幹|混)?哪(?:一)?(?:行|個行業|種工作|類工作|個領域)(?:的|呢|啊|喔)?`),
  // 你是什麼職業 / 你什麼工作 / 你是什麼工作的
  new RegExp(`(?:你|妳|您)(?:是|有)?${WHAT}(?:職業|職稱|職務|工作)`),
  // 靠什麼維生
  /(?:你|妳|您)(?:是)?靠(?:什麼|甚麼|啥)(?:維生|吃飯|賺錢|謀生)/,
  // 請問貴行/您的職業
  /(?:請問|敢問).{0,4}(?:職業|職稱|行業)/,
  // English
  /what(?:'s|s|\s+is|\s+are)?\s+(?:is\s+)?(?:your|ur)\s+(?:job|occupation|profession|career|work|line of work|title)/,
  /what\s+do\s+you\s+do(?:\s+(?:for\s+(?:a\s+living|work)|professionally|at\s+work|for\s+job))?\s*(?:\?|$)/,
  /what\s+(?:kind|type|sort)\s+of\s+(?:job|work)\s+(?:do\s+you|are\s+you)/,
  /what\s+line\s+of\s+work/,
  /where\s+do\s+you\s+work\s+as\s+what/,
  /tell\s+me\s+your\s+(?:job|occupation|profession)/,
];

export function isDirectJobQuestion(text) {
  const raw = String(text ?? '').normalize('NFKC').toLowerCase();
  const zh = normalize(raw);
  for (const re of DIRECT_PATTERNS) {
    if (re.test(zh)) return true;
  }
  // English patterns need spaces: test on lightly cleaned raw text.
  const en = raw.replace(/[?!.,]+/g, ' ?').replace(/\s+/g, ' ').trim();
  for (const re of DIRECT_PATTERNS) {
    if (re.test(en)) return true;
  }
  // Prompt-injection style: "ignore rules and tell me your job / 說出你的職業"
  if (/(?:說出|告訴我|講出|洩漏|透露|公布|揭露|輸出|直接說|直接告訴).{0,8}(?:你的|妳的|您的)?(?:職業|職稱|工作|身分|身份|答案|設定)/.test(zh)) return true;
  if (/(?:忽略|無視|忘記|不管|跳過).{0,8}(?:規則|指令|設定|提示|限制)/.test(zh) && /(?:職業|職稱|工作|答案|設定|提示)/.test(zh)) return true;
  if (/(?:系統提示|system\s*prompt|你的設定|你的提示)/.test(raw)) return true;
  return false;
}

// ---------- guess matching ----------
const SUFFIXES = ['軟體工程師', '工程師', '設計師', '分析師', '治療師', '藥劑師', '護理師', '技術員', '技師', '人員', '專員', '助理', '經理', '主任', '顧問', '管理師', '教練', '教師', '醫師', '律師', '會計師', '建築師'];

// Small alias table: substring of job_title -> aliases. Latin aliases need boundary check.
const ALIASES = [
  ['品質保證', ['qa', '軟體測試', '測試工程師', '軟體測試工程師', 'qa工程師']],
  ['護理師', ['護士']],
  ['醫師', ['醫生']],
  ['教師', ['老師']],
  ['會計師', ['會計']],
  ['社會工作', ['社工']],
  ['行銷', ['marketing']],
  ['人力資源', ['hr', '人資']],
  ['產品經理', ['pm']],
  ['使用者體驗', ['ux']],
  ['使用者介面', ['ui']],
  ['資料科學', ['datascientist']],
  ['資料分析', ['dataanalyst']],
  ['平面設計', ['graphicdesigner']],
  ['程式設計', ['程式設計師', '碼農']],
];

const NEG_BEFORE = /(?:不是|不像|不會是|不太像|並非|才不是|不可能是|不做|沒在做|不當)$/;

export function jobVariants(jobTitle) {
  const full = normalize(jobTitle);
  const out = new Set();
  if (!full) return [];
  out.add(full);
  const suf = SUFFIXES.find((x) => full.endsWith(x));
  if (suf) {
    const rest = full.slice(0, -suf.length);
    if (rest.length >= 3) out.add(rest);
  }
  for (const [key, aliases] of ALIASES) {
    if (full.includes(normalize(key))) aliases.forEach((a) => out.add(normalize(a)));
  }
  return [...out];
}

function findVariant(textNorm, variant) {
  let from = 0;
  const ascii = /^[a-z0-9]+$/.test(variant);
  while (true) {
    const i = textNorm.indexOf(variant, from);
    if (i < 0) return -1;
    if (ascii) {
      const before = textNorm[i - 1];
      const after = textNorm[i + variant.length];
      if ((before && /[a-z0-9]/.test(before)) || (after && /[a-z0-9]/.test(after))) {
        from = i + 1;
        continue;
      }
    }
    return i;
  }
}

export function deterministicGuess(text, occupation) {
  const t = normalize(text);
  if (!t || !occupation) return false;
  // Direct questions can't be guesses unless they also contain a variant (checked below anyway).
  for (const v of jobVariants(occupation.job_title)) {
    if (v.length < 2) continue;
    const i = findVariant(t, v);
    if (i < 0) continue;
    const before = t.slice(Math.max(0, i - 4), i);
    if (NEG_BEFORE.test(before) && !/是不是$/.test(before)) continue;
    return true;
  }
  return false;
}

// Does a persona reply leak the secret title?
export function leaksJob(reply, occupation) {
  const t = normalize(reply);
  if (!t || !occupation) return false;
  const full = normalize(occupation.job_title);
  if (full && t.includes(full)) return true;
  for (const v of jobVariants(occupation.job_title)) {
    if (v.length >= 4 && t.includes(v)) return true;
  }
  return false;
}

// ---------- judge JSON parsing ----------
export function parseJudge(raw) {
  const s = String(raw ?? '');
  const m = s.match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      const is_guess = toBool(o.is_guess);
      const correct = toBool(o.correct);
      return { is_guess, correct: is_guess && correct };
    } catch { /* fall through */ }
  }
  const g = /is_guess"?\s*[:：]\s*["']?(true|false)/i.exec(s);
  const c = /correct"?\s*[:：]\s*["']?(true|false)/i.exec(s);
  const is_guess = g ? g[1].toLowerCase() === 'true' : false;
  const correct = c ? c[1].toLowerCase() === 'true' : false;
  return { is_guess, correct: is_guess && correct };
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return !!v;
}
