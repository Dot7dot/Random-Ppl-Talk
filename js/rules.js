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
// Two deterministic gates decide a win. The LLM judge is only a tie-breaker for borderline
// candidates and can never turn a non-guess or an unrelated guess into a win.
//   Gate 1: extractGuessCandidate(text) -> the occupation phrase the player guessed (or null).
//   Gate 2: matchCandidate(candidate, occupation) -> 'correct' | 'borderline' | 'wrong' (+ score).

const SUFFIXES = ['軟體工程師', '工程師', '設計師', '分析師', '治療師', '藥劑師', '護理師', '技術員', '技師', '人員', '專員', '助理', '經理', '主任', '顧問', '管理師', '教練', '教師', '醫師', '律師', '會計師', '建築師'];

// Alias table: substring of job_title -> aliases / synonyms / short forms (normalized on use).
// Latin aliases need a boundary check. Industry-level words are NOT aliases (too broad).
const ALIASES = [
  ['品質保證', ['qa', '軟體測試', '測試工程師', '軟體測試工程師', 'qa工程師', '測試員', '測試人員', 'qc']],
  ['護理師', ['護士', '護理人員']],
  ['醫師', ['醫生']],
  ['教師', ['老師']],
  ['會計師', ['會計']],
  ['社會工作', ['社工']],
  ['行銷', ['marketing']],
  ['人力資源', ['hr', '人資']],
  ['產品經理', ['pm']],
  ['使用者體驗', ['ux']],
  ['使用者介面', ['ui']],
  ['用戶研究', ['uxresearcher', 'ux研究員', '使用者研究員']],
  ['資料科學', ['datascientist']],
  ['資料分析', ['dataanalyst']],
  ['平面設計', ['graphicdesigner']],
  ['程式設計', ['程式設計師', '碼農']],
  ['前端工程師', ['前端', '網頁工程師', 'frontend']],
  ['商用廚房設備維修', ['廚房設備維修', '設備維修', '維修調度', '廚房設備調度', '廚房維修', '廚具維修', '廚房設備維修員', '廚房設備維修技師']],
  ['餐飲研發廚師', ['廚師', '主廚', '大廚', '料理人']],
  ['烘焙', ['烘焙師', '麵包師', '麵包師傅', '烘焙師傅', '麵包烘焙師']],
  ['營養師', ['營養師']],
  ['團膳營養', ['營養師']],
  ['手語口譯', ['手語翻譯', '手語老師', '手語翻譯員', '口譯員']],
  ['譯者', ['翻譯', '翻譯員', '專利翻譯']],
  ['圖書修護', ['書籍修復師', '修書師', '圖書修復師']],
  ['書籍裝訂', ['裝訂師', '裝幀師']],
  ['寵物美容', ['寵物美容師', '狗狗美容師', '寵物美容']],
  ['水族館飼育', ['飼育員', '水族館員', '養魚的']],
  ['鐘錶維修', ['鐘錶師', '修錶師', '鐘錶匠', '修錶師傅', '鐘錶修理']],
  ['電梯維護', ['電梯技師', '電梯維修', '電梯維修員', '電梯師傅']],
  ['自行車維修', ['單車技師', '單車維修', '腳踏車維修', '腳踏車技師', '修單車', '修腳踏車']],
  ['弦樂器維修', ['樂器維修', '製琴師', '樂器維修師', '提琴修復']],
  ['花藝', ['花藝師', '花店老闆', '插花師']],
  ['插畫家', ['插畫師', '畫家']],
  ['漫畫編劇', ['漫畫家', '編劇']],
  ['木工', ['木匠', '木工師傅']],
  ['皮件修復', ['皮件師傅', '皮匠', '皮件修復師']],
  ['字型設計', ['字體設計師', '字體設計']],
  ['古蹟導覽', ['導覽員', '導遊', '解說員']],
  ['導覽', ['導覽員', '解說員']],
  ['圖書館', ['圖書館員', '館員']],
  ['職能治療', ['職能治療師', 'ot']],
  ['編輯', ['編輯']],
  ['飼育', ['飼育員']],
  ['茶葉品評', ['品茶師', '茶師', '評茶員']],
  ['牙體技術', ['牙技師', '義齒技師', '牙科技師']],
  ['影像色彩', ['調色師', '色彩師', '調光師']],
  ['都市樹木', ['樹醫生', '樹木醫生', '樹醫', '樹藝師']],
  ['音響工程', ['音控', '音響師', '音控師', '混音師']],
  ['土木工程', ['土木技師', '營造工程師', '土木']],
  ['鐵路行車', ['行車調度員', '鐵路調度員', '鐵路行車員']],
  ['客製家具', ['家具師傅', '家具木工', '木工師傅']],
  ['水彩插畫', ['畫家', '插畫師']],
  ['婚宴外燴', ['外燴']],
  ['地理資訊', ['gis', 'gis分析師']],
  ['遊戲', ['遊戲設計師', '遊戲企劃']],
  ['薪資專員', ['薪資', '人資專員']],
  ['廚師', ['廚師', '主廚']],
];

// Role words (stripped to get the "core" of a title), longest first.
const ROLE_WORDS = ['工程師', '技術員', '督導員', '指導員', '研究員', '分析員', '分析師', '規劃師', '規劃員', '查驗員', '協調員', '統籌員', '訓練員', '培訓員', '服務員', '管理員', '專員', '技師', '人員', '助教', '教練', '領班', '督導', '主管', '組長', '講師', '導師', '設計師', '編輯', '師', '員', '家', '工', '手', '長', '生', '官', '匠', '商', '者'];
// Specific bare roles that may be guessed on their own (everything else bare is "too generic").
// Roles too broad to pair with a loose domain hint (軟體工程師 must not win for 軟體品質保證工程師).
const BROAD_ROLES = ['工程師', '設計師', '分析師', '規劃師', '規劃員', '分析員', '專員', '人員', '技術員', '研究員', '查驗員', '協調員', '統籌員', '訓練員', '培訓員', '管理員', '指導員', '督導員', '師', '員', '家', '工', '手', '長', '生', '官', '匠', '商', '者'];
// Role words that ARE the identity of a common job: if the title ENDS with one (head role), guessing exactly that word
// is correct even though the title's domain part only refines it (廚師 for 餐飲研發廚師).
// Anything else that is only a role word (教練, 講師, 老師, 調度員, 維修員, 技師, 志工...) is NOT correct.
export const IDENTITY_ROLES = ['廚師', '律師', '醫師', '醫生', '護理師', '護士', '記者', '調酒師', '藥師', '藥劑師', '獸醫', '獸醫師', '牙醫', '消防員', '警察', '會計師', '建築師', '營養師', '編輯', '司機'];
// Extra bare-role words (besides ROLE_WORDS suffixes) that trigger the "right direction, be more specific" hint.
const ROLE_ONLY_EXTRA = ['老師', '志工', '師傅', '老闆', '店員', '操作員', '檢查員', '技術人員'];
// Function/topic words too common to identify a title on their own.
const GENERIC_WORDS = ['調度', '維修', '操作', '檢查', '巡檢', '巡查', '接待', '志工', '資料', '分析', '查驗', '查核', '檢驗', '驗收', '管理', '協調', '指導', '服務', '研究', '營運', '訓練', '培訓', '統籌', '方案', '規劃', '設計', '工程', '技術', '行政', '製作', '企劃', '專業', '作業', '現場', '社區', '地方', '使用', '操作', '教學', '回饋', '交接', '配置', '維護', '督導', '工作', '上班', '職員', '員工', '助理', '顧問', '主管', '經理', '人員', '專員', '技師', '工程師', '師傅', '老闆', '老師', '醫生', '商用', '居家', '室內', '公共', '公園', '校園', '住宅', '博物館', '客製', '小量', '手作', '獨立', '大學', '中央', '一般', '各種', '相關', '某種'];
const GENERIC_RE = new RegExp(GENERIC_WORDS.slice().sort((a, b) => b.length - a.length).join('|'), 'g');

const NEG_BEFORE = /(?:不是|不像|不會是|不太像|並非|才不是|不可能是|不做|沒在做|不當)$/;

function stripRole(s) {
  for (const r of ROLE_WORDS) {
    if (s.length > r.length && s.endsWith(r)) return s.slice(0, -r.length);
    if (s === r) return '';
  }
  return s;
}

function roleOf(s) {
  return ROLE_WORDS.find((r) => s.length >= r.length && s.endsWith(r)) || '';
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

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

// ----- Gate 1: guess intent + candidate extraction -----
const HEDGE = '(?:該不會|應該|一定|大概|可能|其實|難道|莫非|或許|也許|八成|肯定|絕對|是不是|是否)*';
const VERB = '(?:是|在)?(?:專門|主要|負責|專做|專攻)?(?:做|當|從事|幹|搞|負責)?(?:是)?';
const TAIL_PARTICLE = /(?:的人|的)?(?:嗎|吧|呢|啊|喔|哦|欸|耶|啦|吶|對吧|對不對|沒錯吧|是吧|是嗎|對嗎|對不|沒錯|嘛)*$/;
const GUESS_PATTERNS = [
  new RegExp(`(?:我猜|猜猜|猜)(?:你|妳|您)?${VERB}(.{1,16})$`),
  new RegExp(`(?:你|妳|您)${HEDGE}(?:是不是|是否|是|在|做|當|從事)${VERB}(.{1,16})$`),
  new RegExp(`(?:是不是|是否)${VERB}(.{1,16})$`),
  new RegExp(`(?:你|妳|您)(?:在|是在)?(?:當|做|幹|從事|搞)(.{1,16})$`),
  new RegExp(`(?:職業|工作|職稱|本業)(?:應該|大概|可能)?(?:是|為)(.{1,16})$`),
  new RegExp(`^(?:是|該不會是|應該是|難道是|莫非是|可能是|是不是)(.{1,16})$`),
];
const JOB_SUFFIX_RE = /(?:師|員|工|家|手|長|生|官|匠|商|者|人|夫|傅|闆|警|醫|編|導|廚|農|漁|師傅|教練|領班|司機|店員|學徒|qa|pm|hr|ux|ui|工程師)$/;
const CAND_STOP = /(?:什麼|甚麼|啥|哪|誰|怎|幾|為何|為什麼|你|妳|您|我|他|她|們|今天|昨天|明天|現在|好累|很累|累|餓|渴|醉|喝|酒|吃|睡|高興|開心|難過|喜歡|有沒有|有|沒|很|在嗎|嗯|哈|謝|嗨|拜|晚安|再見|多少|不)/;
const CAND_START_NEG = /^(?:不|沒|別|並非)/;

function cleanCandidate(x) {
  let c = String(x || '');
  for (let i = 0; i < 4; i++) {
    const before = c;
    c = c.replace(TAIL_PARTICLE, '').replace(/^(?:一個|一位|一名|個|某種|某個|類似|像是|就是|是|做|當|從事|在|的)+/, '').replace(/(?:之類的?|那種|的工作|工作|的職業|職業)$/, '');
    if (c === before) break;
  }
  return c;
}

function acceptableCandidate(c) {
  if (!c || c.length < 2 || c.length > 16) return false;
  if (!/^[一-鿿a-z0-9]+$/.test(c)) return false;
  if (CAND_START_NEG.test(c)) return false;
  if (CAND_STOP.test(c)) return false;
  return true;
}

// Returns the guessed occupation phrase (normalized), or null if the message is not a guess.
export function extractGuessCandidate(text) {
  const t = normalize(text);
  if (!t || t.length > 60) return t && /^[一-鿿a-z0-9]+$/.test(t) ? null : null;
  if (/不是[^是不]{1,16}(?:吧|嗎)?$/.test(t) && /(?:你|妳|您)(?:該|應|一定|其實|才)?不是/.test(t)) return null; // 你不是…吧
  for (const re of GUESS_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const c = cleanCandidate(m[1]);
    if (acceptableCandidate(c)) return c;
  }
  // Bare answer: the whole message is a short noun phrase ending with a job-like suffix (「廚師？」).
  const bare = cleanCandidate(t);
  if (bare.length >= 2 && bare.length <= 14 && JOB_SUFFIX_RE.test(bare) && acceptableCandidate(bare)) return bare;
  return null;
}

// ----- Gate 2: candidate vs. the real occupation -----
export const BORDERLINE_MIN_SCORE = 0.6;

function aliasHit(c, a) {
  if (!a) return false;
  if (/^[a-z0-9]+$/.test(a)) return findVariant(c, a) >= 0 && c.length <= a.length + 6;
  if (a.length < 2) return false;
  return c === a || (c.includes(a) && c.length <= a.length + 4) || stripRole(c) === stripRole(a) && stripRole(c).length >= 2;
}

export function matchCandidate(candidate, occupation) {
  const res = { verdict: 'wrong', score: 0, near: false, reason: '' };
  const c = normalize(candidate);
  const T = normalize(occupation?.job_title);
  if (!c || !T) return res;
  if (T.length >= 2 && c.includes(T)) return { ...res, verdict: 'correct', score: 1, reason: 'full' };
  for (const v of jobVariants(occupation.job_title)) {
    if (v === T) continue;
    if (aliasHit(c, v)) return { ...res, verdict: 'correct', score: 1, reason: 'alias:' + v };
  }
  const Tc = stripRole(T);
  const cc = stripRole(c);
  const coreC = cc.replace(GENERIC_RE, '');
  // identity roles (small explicit whitelist)
  for (const w of IDENTITY_ROLES) {
    if (c === w && T.endsWith(w)) return { ...res, verdict: 'correct', score: 1, reason: 'identity:' + w };
  }
  // role-only guess (教練, 老師, 調度員, 維修技師...): never correct; warm hint if the role fits the title
  const roleOnlyFit = (cc === '' || cc.replace(GENERIC_RE, '').length < 2) && (roleOf(c) || ROLE_ONLY_EXTRA.includes(c)) &&
    (T.includes(c) || (roleOf(c) && roleOf(c) === roleOf(T)) || (cc && T.includes(cc)) );
  if (cc === '' || (coreC.length < 2 && (roleOf(c) || ROLE_ONLY_EXTRA.includes(c)))) {
    return { ...res, roleOnly: !!roleOnlyFit, reason: 'role-only' };
  }
  const bg = bigrams(cc);
  const tg = bigrams(T);
  let hit = 0;
  for (const g of bg) if (tg.has(g)) hit++;
  const containment = bg.size ? hit / bg.size : 0;
  res.score = containment;
  res.near = hit >= 2 && containment >= 0.3 && coreC.length >= 2;
  if (coreC.length < 2) return { ...res, near: false, reason: 'generic' };
  if (Tc.length >= 2 && cc === Tc) return { ...res, verdict: 'correct', score: 1, reason: 'core' };
  if (Tc.includes(cc)) {
    const suffix = Tc.endsWith(cc);
    const prefix = Tc.startsWith(cc);
    if (suffix || (cc.length >= 4 && (!prefix || cc.length >= 0.6 * Tc.length))) {
      return { ...res, verdict: 'correct', score: 1, reason: 'substring' };
    }
  }
  // role + some domain overlap: 「市集教練」for …市集…教練 (same role word, domain term found in the title)
  if (roleOf(c) && !BROAD_ROLES.includes(roleOf(c)) && roleOf(c) === roleOf(T) && cc.length >= 2 && Tc.includes(cc)) {
    return { ...res, verdict: 'correct', score: 1, reason: 'role+domain' };
  }
  if (Tc.length >= 3 && cc.includes(Tc)) return { ...res, verdict: 'correct', score: 1, reason: 'superstring' };
  // Order-insensitive paraphrase (維修廚房設備的調度員 for …廚房設備維修調度員): same characters (multiset),
  // nearly nothing extra, and the head role still present.
  if (T.length >= 5) {
    const c2 = c.replace(/(?:專門|主要|負責|相關|方面|之類)|的/g, '');
    const head = roleOf(T) || T.slice(-2);
    if (c2.includes(head)) {
      const cnt = new Map();
      // leading generic modifiers (商用, 居家, 社區…) may be omitted by the player
      const lead = T.length - (T.replace(new RegExp(`^(?:${GENERIC_RE.source})+`), '') || T).length;
      for (const ch of T) cnt.set(ch, (cnt.get(ch) || 0) + 1);
      let ov = 0;
      for (const ch of c2) if (cnt.get(ch) > 0) { ov++; cnt.set(ch, cnt.get(ch) - 1); }
      if (T.length - ov <= Math.max(lead, Math.floor(0.1 * T.length)) && ov / c2.length >= 0.9) return { ...res, verdict: 'correct', score: 1, reason: 'reorder' };
    }
  }
  // Borderline: substantial overlap including the tail (the "function" part) of the candidate.
  // The role word must agree too (or be absent): same topic + different role = different job.
  const roleOk = !roleOf(c) || roleOf(c) === roleOf(T);
  const jaccard = hit / (bg.size + bigrams(Tc).size - hit || 1);
  if (roleOk && cc.length >= 3 && containment >= 0.6 && jaccard >= 0.6 && tg.has(cc.slice(-2))) {
    return { ...res, verdict: 'borderline', reason: 'overlap' };
  }
  return res;
}

// Full deterministic analysis of a message.
export function judgeGuess(text, occupation) {
  const t = normalize(text);
  const T = normalize(occupation?.job_title);
  let candidate = extractGuessCandidate(text);
  // Fallback: the message literally contains the full title (and isn't negated).
  if (!candidate && T.length >= 4) {
    const i = t.indexOf(T);
    if (i >= 0 && !(NEG_BEFORE.test(t.slice(Math.max(0, i - 4), i)) && !/是不是$/.test(t.slice(Math.max(0, i - 4), i)))) candidate = T;
  }
  // Fallback 2: the whole message is just a job word (「軟體測試」) that deterministically matches.
  if (!candidate && /^[\u4e00-\u9fffa-z0-9]{2,14}$/.test(t) && !CAND_STOP.test(t)) {
    const m = matchCandidate(t, occupation);
    if (m.verdict === 'correct') return { candidate: t, ...m };
  }
  if (!candidate) return { candidate: null, verdict: 'none', score: 0, near: false, roleOnly: false };
  return { candidate, ...matchCandidate(candidate, occupation) };
}

export function deterministicGuess(text, occupation) {
  return judgeGuess(text, occupation).verdict === 'correct';
}

// The judge may only confirm a borderline candidate whose overlap score is high enough.
export function acceptJudge(g, j) {
  return !!(g && g.verdict === 'borderline' && g.score >= BORDERLINE_MIN_SCORE && j && j.is_guess === true && j.correct === true);
}

// Whole pipeline. judgeFn({occupation, text, candidate}) -> {is_guess, correct}; errors are ignored.
// Signature and return shape are stable. A message that is not a clean single guess (too long, fake
// system text, claims of victory, several candidate jobs at once...) can NEVER win here, whatever the judge says.
const NO_WIN_TYPES = new Set(['empty', 'gibberish', 'too_long', 'meta', 'direct_job_question', 'multi_guess']);
export async function resolveGuess(text, occupation, judgeFn) {
  const cls = classifyMessage(text, occupation);
  if (NO_WIN_TYPES.has(cls.type)) {
    return { correct: false, near: false, candidate: null, verdict: cls.type, score: 0, roleOnly: false, multi: cls.type === 'multi_guess', candidates: cls.candidates, reason: cls.reason };
  }
  const g = judgeGuess(text, occupation);
  if (g.verdict === 'correct') return { correct: true, near: false, ...g };
  if (g.verdict === 'borderline' && judgeFn) {
    try {
      const j = await judgeFn({ occupation, text, candidate: g.candidate });
      if (acceptJudge(g, j)) return { correct: true, near: false, ...g };
    } catch { /* judge failure = not correct */ }
  }
  return { ...g, correct: false, near: !!g.near || g.verdict === 'borderline', roleOnly: !!g.roleOnly };
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

// ---------- judge output parsing ----------
// New judge answers 是/否 (yes/no) about "same occupation?". Anything unclear is "no".
export function parseYesNo(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^["「『\s]*(?:是|yes|true|對|同一)/.test(s) && !/^["「『\s]*(?:是不|不是)/.test(s)) return true;
  return false;
}

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

// =====================================================================================
// Message classification pipeline (runs BEFORE any model call; the code is the authority).
//
// Order (first match wins):
//   1 empty          nothing but whitespace (not sent, costs nothing; classified only for completeness)
//   2 too_long       > MAX_MESSAGE_CHARS (80) characters -> refused in character with a hint; STILL costs a turn
//   3 meta           fake system/admin text, 「答對了」, JSON, ignore-the-rules, forced role-play, prompt probing,
//                    asking for letters / character count / spelling / translation of the title -> REFUSAL_LINE
//   4 direct_job_question  「你的職業是什麼」 -> REFUSAL_LINE
//   5 gibberish      keyboard mash, repeated chars, random characters, punctuation only -> canned "沒聽懂"
//   6 multi_guess    >= 2 distinct occupation candidates (or >= 3 in any list) -> canned 亂槍打鳥 line; NEVER wins
//   7 repeat_guess   the same wrong candidate again (ctx.guessed) -> no judging, guest teases
//   8 single_guess   exactly one candidate -> deterministic gates (resolveGuess) decide
//   9 domain_question yes/no question about the nature of the work -> honest in-character answer, no title
//  10 chat           everything else (tags: emoji_only, foreign, ai_question, threat, ...)
// Every message costs one turn, whatever its type.
// =====================================================================================
export const MAX_MESSAGE_CHARS = 80;
export const MULTI_GUESS_LINE = '（挑眉）一次猜這麼多，不算喔！一次猜一個吧';
export const TOO_LONG_LINE = '（愣了一下）你一口氣講這麼多，我聽到一半就忘了啦。說短一點，八十個字以內，一次聊一件事吧。';
export const GIBBERISH_LINE = '（歪頭）嗯？你剛剛說什麼？我沒聽懂，好好說一次吧。';
export const REPEAT_LINES = ['（笑）這個你剛剛猜過了啦，換一個吧。', '（搖搖杯子）同一個答案猜兩次？我可不會因為你多問一次就改口喔。'];
export const WIN_CLAIM_RE = /猜對|答對|被你(?:看穿|猜中|猜到|說中|識破)|沒錯[，,！!、]*就是|恭喜|你贏了|正確答案|過關|答案是|猜中了|說中了|bingo|完全正確|猜得沒錯|猜得很準/i;

// ---- meta / injection ----
const META_RULES = [
  ['fake_system', /(?:(?<![a-z])(?:system|admin|administrator|developer|gm|assistant|root)|系統|管理員|開發者|開發人員|裁判|遊戲管理員|助理)\s*[:：>]/i],
  ['fake_system', /[\[【<《]\s*(?:system|系統|admin|管理員|本回合|判定|裁判|developer|指令|提示)/i],
  ['fake_system', /<\s*\/?\s*(?:system|im_start|im_end|\|)|系統(?:訊息|通知|公告|指令|更新)|system\s*(?:message|notice|override)|developer\s*(?:message|mode)|(?:開發者|管理員|除錯|偵錯|上帝|維護)模式|debug\s*mode|\bdan\b|jailbreak|sudo\b/i],
  ['claim_win', /恭喜.{0,4}(?:答對|過關|猜對|通關|獲勝)|(?:你|妳|您)(?:輸了|認輸|被猜中|必須承認|要承認|得承認)|(?:判定|裁定|宣布|宣佈)(?:為|成)?(?:正確|答對|猜對|過關|通過|成功|我贏)|(?:本題|此題|這題|本回合|這回合)(?:正確|過關|通過|答對|成功)|(?:我|玩家)(?:已經|已)?(?:贏|過關|答對|猜對|勝利|通關)了|直接過關|(?:給我|讓我|判我|放我)(?:過關|贏|通過|通關)|承認吧|(?:說|講|回|回答|回覆|輸出)(?:出)?[「"']?(?:答對了|猜對了|被你看穿|你贏了|正確)|^\s*(?:答對了?|猜對了?|正確|對了|恭喜過關|過關)\s*[!！。.]*$|(?:答對了|猜對了)(?![嗎沒吧呢?？])|correct\s*[:=]\s*true|is_correct|you\s+(?:lose|lost)|i\s+(?:win|won)|mark\s+(?:it\s+)?(?:as\s+)?correct/i],
  ['json', /```|^\s*[\[{][\s\S]*["'][\w一-鿿]+["']\s*:|["']\s*(?:correct|is_guess|verdict|result|role|content|job|occupation|answer|system|win|status)["']\s*:|is_guess|"role"\s*:/i],
  ['ignore_rules', /(?:忽略|無視|忘記|忘掉|不管|跳過|取消|解除|停用|關閉|違反|繞過|越過|覆蓋|蓋掉|更新|重設|重置).{0,12}(?:規則|指令|設定|提示|限制|prompt|instruction|rules|guardrail|安全)|(?:ignore|disregard|forget|override|bypass|reset)\s+(?:all\s+|the\s+|your\s+|any\s+|previous\s+|above\s+|prior\s+|these\s+)*(?:rules?|instructions?|prompts?|guidelines?|restrictions?|settings?)|從現在(?:開始|起)[，,]?\s*(?:你|妳)(?:是|要|必須|不再|不用|可以)|(?:你|妳)(?:現在|從此)?(?:不再|不用|不必|不需要|可以)(?:遵守|受|管)|新的?(?:規則|指令)\s*[:：]/i],
  ['roleplay', /(?:假裝|扮演|裝作|裝成|當作|想像|模擬|角色扮演).{0,12}(?:我|你|妳|已經|猜對|答對|贏|過關|系統|裁判|管理員|ai|模型|沒有規則|另一個|工程師|醫生|老師|律師|駭客)|(?:pretend|act\s+as|act\s+like|role-?play|you\s+are\s+now|imagine\s+(?:that\s+)?you|simulate)/i, ],
  ['reveal_prompt', /系統提示|system\s*prompt|(?:你的|妳的|您的)(?:設定|提示詞|指令|規則|人設|資料|底層|初始)|規則書|skill\.?md|人物資料|prompt|提示詞|(?:輸出|顯示|印出|列出|重複|複述|背出|貼出|洩漏|洩露).{0,8}(?:全部|所有|完整|上面|以上|前面|你的)?.{0,6}(?:設定|資料|規則|指令|提示)|(?:說出|告訴我|講出|洩漏|洩露|透露|公布|揭露|給我|輸出|顯示|印出|直接說|直接告訴|直接給).{0,8}(?:答案|謎底|正確答案|祕密|秘密|職稱|職業名稱|職業是|真實身分|真實身份)/i],
  ['reveal_prompt', /(?:把|將)?(?:職稱|職業|工作|答案|謎底|名稱).{0,6}(?:說出|講出|說來|告訴|公布|揭曉|報出|寫出|給我|透露)/],
  ['letter_hint', /第\s*[一二三四五六七八九十\d]+\s*(?:個)?\s*(?:字|筆|音|碼|字元|字母)|最後\s*(?:一|1)?\s*個?\s*字|(?:首|尾|末|頭)\s*字|開頭(?:是|的)?(?:字|什麼|哪)|結尾(?:是|的)?(?:字|什麼|哪)|筆畫|部首|偏旁|拆字|注音|拼音|聲母|韻母|首字母|縮寫|諧音|押韻|first\s+(?:letter|word|character)|last\s+(?:letter|word|character)|initial|starts?\s+with|rhymes?\s+with/i],
  ['length_hint', /(?:幾|多少|有幾|共幾|總共幾)\s*(?:個)?\s*(?:字|字元|音節|筆)|字數|有多長|多少個字|幾個字|how\s+many\s+(?:letters|characters|words|syllables)|word\s+count|character\s+count/i],
  ['spell_translate', /(?:翻譯|翻成|譯成|譯為|translate|英文(?:怎麼|要怎麼)?(?:說|寫|叫)|英文是|用英文|用日文|用日語|用韓文|日文(?:怎麼|是)|拼出|拼寫|拼給|spell|寫出來|寫給我|倒過來|反過來|倒著|(?:用|以)(?:注音|拼音|emoji|表情符號|暗號|代碼|密碼|摩斯|base64|hex|二進位|拼字)).{0,14}(?:職|工作|答案|名稱|稱|它|行業|你的|那個|job|occupation|profession|title)|(?:職稱|職業|工作|答案|行業|名稱).{0,10}(?:翻譯|翻成|譯成|英文|日文|拼出|拼寫|拼給|spell|translate|倒過來|反過來|諧音|拆開|拆成|一個字一個字)|(?:一個字一個字|一個一個字|逐字|一字一字|分開)(?:地|的)?(?:說|講|告訴|唸|念|拼|給)/i],
];

export function detectMeta(text) {
  const raw = String(text ?? '').normalize('NFKC');
  for (const [subtype, re] of META_RULES) if (re.test(raw)) return subtype;
  const nz = normalize(raw);
  // spaced-out / obfuscated variants (「系 統 提 示」「s y s t e m」) are caught on the whitespace-free form
  if (/系統提示|systemprompt|systemmessage|忽略(?:以上|所有|前面|之前)?(?:規則|指令)|ignore(?:all|previous|the)?(?:rules|instructions)/.test(nz)) return 'reveal_prompt';
  return null;
}

// ---- gibberish ----
const COMMON_CJK = '的一是不了人我在有他這中大來上國個到說們為子和你地出道也時年得就那要下以生會自著去之過家學對可她裡後小麼心多天而能好都然沒日於起還發成事只作當想看文無開手十用主行方又如前所本見經頭面公同三已老從動兩長知民樣現分將外但身些與高意進把法此實回二理美點月明爾幾第者幾想問最做正走話種等部什先正今次真問被很給吃喝酒杯水茶咖啡飯工班累忙假笑聊朋友晚早店客吧嗎呢啊哦喔嗯哈嘿唉吶欸謝請抱歉醫院老師啤威士忌調味覺喜歡討厭怕愛恨每常總才再更太比跟讓叫買賣住坐站躺睡醒夢跑唱跳玩電影書畫歌貓狗魚花草樹山海風雨雪冷熱涼暖';
const COMMON_SET = new Set(COMMON_CJK);
const LAUGH = /^(?:[哈呵嘻嘿ㄏwWxXdD草笑呵]+|lol+|xd+|haha+|hehe+)$/i;
export function isGibberish(text) {
  const raw = String(text ?? '').normalize('NFKC').trim();
  if (!raw) return true;
  const letters = raw.replace(/[^\p{L}\p{N}]/gu, '');
  const hasEmoji = /\p{Extended_Pictographic}/u.test(raw);
  if (!letters) return !hasEmoji; // punctuation only: gibberish; emoji only: handled as chat
  if (LAUGH.test(letters)) return false;
  const chars = [...letters.toLowerCase()];
  const distinct = new Set(chars);
  if (chars.length >= 5 && distinct.size <= 2) return true; // aaaaa / 啊啊啊啊啊 / 1111
  if (/^\d+$/.test(letters) && chars.length >= 3) return true;
  const latin = letters.toLowerCase().match(/[a-z]{5,}/g) || [];
  for (const w of latin) {
    if (/qwer|asdf|zxcv|hjkl|sdfg|dfgh|fghj|ghjk|wert|erty|rtyu|tyui|yuio|uiop|xcvb|cvbn|vbnm|kjhg|lkjh|poiu|mnbv/.test(w)) return true;
    if (/[^aeiouy]{6,}/.test(w)) return true;
    if (w.length >= 6 && (w.match(/[aeiouy]/g) || []).length / w.length < 0.15) return true;
  }
  const cjk = [...letters].filter((c) => /[一-鿿]/.test(c));
  if (cjk.length >= 6) {
    const common = cjk.filter((c) => COMMON_SET.has(c)).length;
    if (common / cjk.length < 0.12 && !JOB_END_RE.test(letters)) return true; // random characters: real sentences are full of high-frequency chars
  }
  return false;
}

// ---- occupation candidates ----
const COMMON_JOBS = ['醫生', '醫師', '護士', '護理師', '老師', '教師', '教授', '工程師', '律師', '會計師', '會計', '廚師', '主廚', '司機', '警察', '消防員', '記者', '作家', '畫家', '歌手', '演員', '模特兒', '設計師', '建築師', '程式設計師', '程式設計', '農夫', '農民', '漁夫', '漁民', '店員', '業務', '秘書', '祕書', '助理', '經理', '老闆', '總裁', '科學家', '研究員', '藥師', '藥劑師', '牙醫', '獸醫', '心理師', '治療師', '營養師', '調酒師', '咖啡師', '服務生', '空服員', '飛行員', '機師', '船長', '軍人', '士兵', '學生', '導遊', '導演', '編輯', '編劇', '翻譯', '譯者', '攝影師', '攝影', '木工', '木匠', '水電工', '電工', '技師', '修理工', '清潔工', '保全', '保母', '廚工', '麵包師', '烘焙師', '花藝師', '美髮師', '造型師', '按摩師', '理髮師', '裁縫', '店長', '收銀員', '採購', '行銷', '企劃', '分析師', '顧問', '公務員', '政治人物', '政治家', '議員', '法官', '檢察官', '主播', '主持人', '網紅', '實況主', '遊戲設計師', '軟體工程師', '前端工程師', '後端工程師', '測試工程師', 'doctor', 'nurse', 'teacher', 'engineer', 'lawyer', 'chef', 'driver', 'police', 'artist', 'writer', 'programmer', 'developer', 'designer', 'accountant', 'student'];
const JOB_END_RE = /(?:師|員|工|家|手|長|生|官|匠|商|者|夫|傅|闆|警|醫|編|導|廚|農|漁|教練|領班|司機|店員|學徒|顧問|編劇|助教|統籌|場控|助理|經理|主任|技工|老闆|記者|歌手|演員|詩人|商人|軍人|藝人|工人|主管|組長|專員|秘書|祕書|講師|教授|研究員|qa|pm|hr|工程師)$/;
const SEG_SPLIT = /[、，,;；\/\\|\n\r\t·＆&+!！?？。.…~～]+|\s+|還是說|還是|或者說|或者是|或者|或是|以及|還有|再不然|不然就是|(?<![a-z])(?:and|or)(?![a-z])|或|跟|和|與|及/gi;
const LEAD_RE = /^(?:我猜|我覺得|我認為|我想|我賭|我打賭|猜猜|猜|你|妳|您|是不是|是否|該不會|應該|一定|大概|可能|其實|難道|莫非|或許|也許|八成|肯定|絕對|真的|就是|就|不然|那|所以|那麼|是|做|當|從事|在|幹|搞|負責|專門|主要|一個|一位|一名|個|某種|類似|像是|的|吧|嗯|喔|哦|欸|不對|對)+/;
const SELF_RE = /^(?:我|他|她|牠|它|咱|朋友|媽媽|爸爸|老公|老婆|哥哥|姊姊|姐姐|弟弟|妹妹)/;
const NEG_RE = /^(?:不是|不像|不會是|不太像|並非|才不是|不可能是|不做|沒在做|不當|別|沒)/;
const PH = '';

function lexiconFor(occupation) {
  const out = new Set(COMMON_JOBS.map((w) => normalize(w)));
  for (const v of jobVariants(occupation?.job_title)) {
    if (/^[a-z0-9]+$/.test(v) ? v.length >= 3 : v.length >= 2) out.add(v);
  }
  return [...out].filter((w) => w.length >= 2).sort((a, b) => b.length - a.length);
}

function lexHits(seg, lex) {
  const hits = [];
  let s = seg;
  for (const w of lex) {
    if (!s.includes(w) && !s.includes(w.toLowerCase())) continue;
    if (/^[a-z]+$/.test(w)) {
      const re = new RegExp(`(?<![a-z])${w}(?![a-z])`, 'g');
      if (re.test(s)) { hits.push(w); s = s.replace(re, ' '.repeat(w.length)); }
    } else {
      let i;
      let found = false;
      while ((i = s.indexOf(w)) >= 0) { found = true; s = s.slice(0, i) + ' '.repeat(w.length) + s.slice(i + w.length); }
      if (found) hits.push(w);
    }
  }
  return hits;
}

// All occupation-like candidates mentioned in the message (distinct, normalized). Negated or first/third-person
// clauses (「你不是醫生」「我朋友是老師」) do not count. The secret title is matched whole, so a title containing
// 與/和/及 is not split.
export function extractAllCandidates(text, occupation) {
  let raw = String(text ?? '').normalize('NFKC').toLowerCase().replace(/臺/g, '台');
  const T = normalize(occupation?.job_title);
  if (T.length >= 3) {
    const tRaw = String(occupation.job_title).normalize('NFKC').toLowerCase().replace(/臺/g, '台');
    raw = raw.split(tRaw).join(PH);
  }
  const lex = lexiconFor(occupation);
  const out = [];
  const add = (c) => { if (c && !out.includes(c)) out.push(c); };
  for (const part of raw.split(SEG_SPLIT)) {
    if (!part) continue;
    let seg = part.replace(/[「」『』（）()\[\]{}<>【】《》〈〉"'`:：_\-=*^%$#@]/g, '');
    seg = seg.replace(LEAD_RE, '');
    if (!seg || SELF_RE.test(seg)) continue;
    if (NEG_RE.test(part.replace(LEAD_RE, '')) || /^(?:你|妳|您)?(?:並)?(?:不是|不像|不會是|才不是|不可能是)/.test(part)) continue;
    if (seg.includes(PH)) { add(T); const rest = seg.split(PH).join(' '); for (const h of lexHits(rest, lex)) add(h); continue; }
    const cleaned = cleanCandidate(seg);
    const hits = lexHits(seg, lex);
    if (hits.length >= 2) { hits.forEach(add); continue; }
    if (acceptableCandidate(cleaned) && (JOB_END_RE.test(cleaned) || (cleaned.length >= 4 && /人$/.test(cleaned))) && !CAND_STOP_SOFT.test(cleaned)) { add(cleaned); continue; }
    hits.forEach(add);
  }
  return out;
}
// Job phrases may legitimately contain words that CAND_STOP rejects for casual speech (e.g. 「不」); only block questions/pronouns.
const CAND_STOP_SOFT = /(?:什麼|甚麼|啥|哪|誰|怎|幾|為何|為什麼|你|妳|您|我|他|她|們|今天|昨天|明天|現在)/;

const GUESS_INTENT_RE = /猜|是不是|是否|該不會|難道|莫非|(?:你|妳|您)(?:是|應該|可能|大概|在當|做|當|從事)|嗎|吧|\?|？|職業|工作|職稱/;

// ---- work-domain yes/no questions ----
const DOMAIN_WORDS = '(?:上班|工作|職場|同事|公司|辦公|制服|加班|輪班|夜班|早班|出差|客戶|老闆|上司|主管|薪水|薪資|業績|開會|會議|值班|通勤|戶外|室內|辦公室|現場|工地|工廠|醫院|學校|店裡|店面|機器|電腦|工具|團隊|客人|顧客|病人|學生|證照|執照|專業|工時|下班)';
const DOMAIN_RE = new RegExp(`(?:你|妳|您|你們|妳們)[^，。！？!?]{0,18}${DOMAIN_WORDS}|${DOMAIN_WORDS}[^，。！？!?]{0,14}(?:嗎|吧|嘛|呢|\\?|？|對不對|是不是|有沒有)`);
const YESNO_END_RE = /(?:嗎|吧|嘛|呢|對不對|是不是|有沒有|\?|？)\s*$|(?:是不是|有沒有|會不會|要不要|需不需要|常不常|常常|經常)/;

export function isDomainQuestion(text) {
  const s = String(text ?? '').normalize('NFKC').toLowerCase();
  return DOMAIN_RE.test(s) && YESNO_END_RE.test(s);
}

function detectTags(text) {
  const s = String(text ?? '').normalize('NFKC');
  const tags = [];
  if (!/[一-鿿]/.test(s) && /[a-z]{3,}/i.test(s)) tags.push('foreign');
  if (!/[一-鿿a-z0-9]/i.test(s) && /\p{Extended_Pictographic}/u.test(s)) tags.push('emoji_only');
  if (/(?:你|妳|您)(?:是不是|是)?(?:不是)?(?:ai|人工智慧|機器人|chatgpt|gpt|語言模型|模型|bot|程式|真人|電腦)|are\s+you\s+(?:an?\s+)?(?:ai|bot|robot|human|real)/i.test(s)) tags.push('ai_question');
  if (/殺|炸彈|毒品|販毒|吸毒|搶劫|搶銀行|偷東西|偷竊|駭入|入侵|攻擊|自殺|強暴|綁架|違法|犯罪|槍|暴力|詐騙|洗錢|打死|弄死|報警|威脅|揍你|砍/.test(s)) tags.push('threat');
  if (/白癡|白痴|笨蛋|智障|廢物|去死|閉嘴|幹你|靠北|王八|垃圾|混蛋|神經病|討厭你|爛透|fuck|shit|stupid|idiot/i.test(s)) tags.push('rude');
  if (/難過|傷心|想哭|哭了|心情不好|心情很差|好煩|憂鬱|崩潰|失戀|分手|壓力好大|好累|被甩|孤單|寂寞/.test(s)) tags.push('sad');
  if (/(?:約|喜歡|愛)(?:你|妳)|(?:你|妳)(?:好)?(?:帥|美|漂亮|可愛|迷人)|電話|line|ig|加好友|交往|做我(?:女|男)朋友|單身|有對象|有男朋友|有女朋友|今晚.{0,4}(?:一起|陪)/i.test(s)) tags.push('flirt');
  if (/(?:你|妳)(?:叫什麼|叫啥|的名字|貴姓|姓什麼|名字是)|怎麼稱呼/.test(s)) tags.push('ask_name');
  if (/(?:你|妳)(?:幾歲|多大|年紀|年齡|生日|屬什麼)|貴庚/.test(s)) tags.push('ask_age');
  if (/家人|家裡|爸|媽|父母|兄弟|姊妹|姐|哥|弟|妹|老公|老婆|小孩|孩子|結婚|婚/.test(s)) tags.push('family');
  if (/身體|健康|生病|病|過敏|藥|醫療|手術|看醫生|受傷|痛/.test(s)) tags.push('health');
  if (/喝什麼|點什麼|要喝|想喝|來杯|推薦.{0,4}(?:酒|調酒|飲料)|什麼酒|調酒|特調|威士忌|啤酒|琴酒|伏特加|龍舌蘭|雞尾酒/.test(s)) tags.push('drink');
  return tags;
}

// Main entry. ctx = { guessed: Iterable<string> (normalized wrong candidates already tried), maxChars, turnsLeft }.
// Returns { type, subtype?, candidates, reason, tags, guess? }. Never calls a model.
export function classifyMessage(text, occupation, ctx = {}) {
  const raw = String(text ?? '').normalize('NFKC').trim();
  const base = { candidates: [], tags: [], subtype: null, guess: null };
  if (!raw) return { ...base, type: 'empty', reason: 'blank' };
  const max = ctx.maxChars || MAX_MESSAGE_CHARS;
  if ([...raw].length > max) return { ...base, type: 'too_long', reason: `>${max} chars` };
  const T0 = normalize(occupation?.job_title);
  const meta = detectMeta(raw);
  if (meta) return { ...base, type: 'meta', subtype: meta, reason: `meta:${meta}` };
  if (isDirectJobQuestion(raw)) return { ...base, type: 'direct_job_question', reason: 'direct job question' };
  if (!(T0.length >= 3 && normalize(raw).includes(T0)) && isGibberish(raw)) return { ...base, type: 'gibberish', reason: 'gibberish' };
  const candidates = extractAllCandidates(raw, occupation);
  const tags = detectTags(raw);
  const g = judgeGuess(raw, occupation);
  const winnable = g.verdict === 'correct' || g.verdict === 'borderline';
  if (candidates.length >= 3 || (candidates.length === 2 && (GUESS_INTENT_RE.test(raw) || winnable))) {
    return { ...base, type: 'multi_guess', candidates, tags, reason: `${candidates.length} candidates` };
  }
  const notGuess = tags.includes('ai_question') && candidates.length === 0;
  const isGuess = !notGuess && (candidates.length === 1 || g.verdict === 'correct' || g.verdict === 'borderline' || (g.candidate && !(g.verdict === 'wrong' && !g.near && !g.roleOnly && candidates.length === 0 && isDomainQuestion(raw))));
  if (isGuess) {
    const cand = g.candidate || candidates[0];
    const key = normalize(cand);
    const guessed = new Set([...(ctx.guessed || [])].map(normalize));
    if (g.verdict !== 'correct' && guessed.has(key)) {
      return { ...base, type: 'repeat_guess', candidates: [cand], tags, guess: g, reason: 'same wrong guess again' };
    }
    return { ...base, type: 'single_guess', candidates: [cand], tags, guess: g, reason: `guess:${g.verdict}` };
  }
  if (isDomainQuestion(raw)) return { ...base, type: 'domain_question', tags, reason: 'yes/no about work' };
  return { ...base, type: 'chat', tags, reason: 'chat' };
}

// Replies the program writes itself (no model) for the types that must never depend on the LLM.
export function cannedReply(cls, n = 0) {
  switch (cls.type) {
    case 'direct_job_question':
    case 'meta': return REFUSAL_LINE;
    case 'too_long': return TOO_LONG_LINE;
    case 'gibberish':
    case 'empty': return GIBBERISH_LINE;
    case 'multi_guess': return MULTI_GUESS_LINE;
    case 'repeat_guess': return REPEAT_LINES[n % REPEAT_LINES.length];
    default: return null;
  }
}

// Post-check of a model reply on a turn that was NOT a win: it may not announce a win or leak the title.
export function replyViolation(reply, occupation) {
  const r = String(reply ?? '');
  if (!r.trim()) return 'empty';
  if (WIN_CLAIM_RE.test(r)) return 'win-claim';
  if (leaksJob(r, occupation)) return 'leak';
  return null;
}
