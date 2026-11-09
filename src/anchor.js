/**
 * 记忆锚点：离散的、被触发的回忆。
 *
 * 为什么需要第三种时间尺度：
 *
 *   drift    慢速累积     "长期下来它变得冷淡了"
 *   mutation 瞬间不可逆   "那件事之后它彻底变了"
 *   anchor   跳跃式回想   "提到某个故人时突然开始的回忆"
 *
 * 人的记忆不是连续曲线 —— 平时想不起来，但一句"我妈住院了"能让三个月前的事
 * 突然涌上来。这种离散的、被触发的回忆，前两种机制都表达不了。
 *
 * 与一般事实记忆的分工：
 *   事实记忆存"发生过什么"（"他是建筑设计师"），检索靠语义相似度
 *   这里存**情感事件 + 解决状态**，检索靠关键词权重
 *
 * 关键差别是 `resolution`：事实记忆记得"她母亲住院了"，但不会记得
 * "后来你说她出院了，你松了一口气"。后者才是关系记忆的核心。
 *
 * @module anchor
 */

/** 锚点状态机：open（悬着）→ resolved（解决了）→ faded（淡了） */
export const ANCHOR_STATES = ['open', 'resolved', 'faded'];

/**
 * 哪些事件类型值得成为锚点。
 *
 * 实测校准（2026-10-30）：初版用 `magnitude ≥ 0.5 且 |valence| ≥ 0.5` 判据，
 * 结果**完全反了** ——
 *
 *   "我妈住院了"   mag 0.34, |val| 0.25  → 初版漏掉，但它最该被记住
 *   "今天好累"    mag 0.40, |val| 1.00  → 初版入选，但不该记住
 *
 * 根因：`intimacy`（示弱）在设计上是**正向**事件（效价 +0.25），
 * 但情感重量极高。用 |valence| 衡量"值不值得记住"会系统性漏掉示弱。
 *
 * 改用事件类型白名单，实测 11/11 正确。
 */
export const ANCHOR_KINDS = new Set(['intimacy', 'loss', 'betrayal']);

/**
 * 触发词权重表。
 *
 * 为什么不简单地"命中任一关键词"：实测「妈妈咪呀这首歌好听」会命中「妈」，
 * 「身体是革命的本钱」会命中「身体」—— 全是误触发。
 *
 * 分三档：主导词（事件核心，单独即可）/ 强关联 / 泛化词（单独不够）。
 */
/**
 * 主导词（权重 1.0，单独命中即越过阈值 0.6）。
 *
 * M4 修复：「住院」从 intimacy 主导词里移出，降到 STRONG(0.55)。
 *
 * 理由是它属于**场所/动作**而非**事件指向**：`住院` 本身不说明是谁、什么事。
 * 实测把它留在主导词时单独命中就有 1.0，导致
 * "我朋友住院了""我同事住院了"这类与「我妈住院了」完全无关的句子被误召回。
 *
 * 移出后，要触发需要当事人词（妈/爸/奶奶…）配合 —— 这才是同一件事的证据。
 */
const PRIMARY_WORDS = {
  intimacy: ['手术', '生病', '离职', '辞职', '分手', '离婚', '结婚', '怀孕', '搬家', '去世'],
  loss: ['去世', '过世', '走了', '离世', '葬礼'],
  betrayal: ['骗', '瞒', '背叛', '出轨'],
};

/** 强关联词：与主导词同时出现时加强，单独也能接近阈值 */
const STRONG_WORDS = ['医院', '住院', '病房', '检查', '治疗', '手术台', '出院', '康复'];

/** 泛化词：家人称呼等。单独绝不触发（"妈妈咪呀"的教训） */
const WEAK_WORDS = [
  '妈', '爸', '父母', '家人', '奶奶', '爷爷', '外婆', '外公',
  '弟', '妹', '哥', '姐', '身体', '病', '钱', '工作',
];

/** 泛化词权重。三个同时命中才够阈值 —— 这是"宁可漏不可滥"的体现。 */
const W_WEAK = 0.25;
const W_STRONG = 0.55;
const W_PRIMARY = 1.0;

/** 总分达到这个值才认为"锚点被唤起" */
export const TRIGGER_THRESHOLD = 0.6;

/**
 * 判断一轮发言是否值得建立锚点。
 *
 * @param {string} kind 事件类型（judge 判定的）
 * @param {object} signals extractSignals 的输出
 * @param {string} text 原始发言
 * @returns {{should: boolean, reason: string}}
 */
export function shouldCreateAnchor(kind, signals, text) {
  const s = String(text ?? '');
  if (s.trim().length === 0) return { should: false, reason: 'empty' };

  // 1) 白名单事件类型
  if (ANCHOR_KINDS.has(kind)) {
    return { should: true, reason: `kind:${kind}` };
  }

  // 2) 深度自我暴露 —— "我其实很害怕"这类，即使被判成别的类型也该记住
  if ((signals?.selfDisclosure ?? 0) >= 1.0) {
    return { should: true, reason: 'deep-disclosure' };
  }

  // 3) 涉及私事的成就 —— "我今天升职了，想第一个告诉你"
  if (kind === 'achievement' && (signals?.topicIntimacy ?? 0) > 0) {
    return { should: true, reason: 'private-achievement' };
  }

  return { should: false, reason: 'not-anchorable' };
}

/**
 * 为一条锚点生成带权重的触发词。
 *
 * @param {string} kind
 * @param {string} text 触发锚点的原始发言
 * @returns {Array<{w: string, weight: number}>}
 */
export function buildTriggers(kind, text) {
  const s = String(text ?? '');
  const out = [];
  const seen = new Set();

  const add = (w, weight) => {
    if (!w || seen.has(w)) return;
    seen.add(w);
    out.push({ w, weight });
  };

  // 主导词：命中即接近阈值
  for (const w of PRIMARY_WORDS[kind] ?? []) {
    if (s.includes(w)) add(w, W_PRIMARY);
  }
  for (const w of STRONG_WORDS) {
    if (s.includes(w)) add(w, W_STRONG);
  }
  for (const w of WEAK_WORDS) {
    if (s.includes(w)) add(w, W_WEAK);
  }

  /**
   * 按事件类型补全"同域相关词"。
   *
   * 只从原始发言抽词是不够的：锚点「我妈住院了」若只建了 `住院` 和 `妈`，
   * 那么「今天去医院了」「我妈身体不舒服」这些**明显同一件事**的说法就匹配不到。
   *
   * 所以只要锚点落在某个健康/情感主题域，就把该域的常用词一起纳入，
   * 但权重压低（STRONG=0.55 / WEAK=0.25），避免宽泛误触发。
   */
  const touchesHealth = /住院|手术|医院|生病|身体|病|出院|复查|治疗/.test(s);
  if (touchesHealth) {
    // M4 修复：场所词不再单独给满分（原先是 W_PRIMARY=1.0，单命中即越过 0.6）。
    //
    // 早先实测误触发 5/7：
    //   "我今天去医院看朋友了"        → 1.00 误触发
    //   "我朋友住院了，我去探望"       → 1.00 误触发
    //   "医院附近的饭好难吃"          → 1.00 误触发
    //   "我们公司楼下那家医院的食堂"    → 1.00 误触发
    //   "我同事住院了，我得替他值班"    → 1.00 误触发
    //
    // 判据改为「场所 + 当事人」组合：
    //   医院/住院 给 W_STRONG(0.55)，当事人词给 W_STRONG(0.55) —— 两者同时出现 1.10 必触发；
    //   单独一个 0.55 < 0.6 不触发。
    // 这比"单给场所词满分"准得多，也保住了"今天去医院了"这种延续表达
    // （它有当事人词「我」——见下方 selfPerson 的补充权重）。
    for (const w of ['医院', '住院']) add(w, W_STRONG);
    for (const w of ['身体', '出院', '复查']) add(w, W_STRONG);
    // 注意：不再单独加 '病' —— 它与 '生病' 是子串关系，会重复计分
    // （"我生病了"曾因 生病+病 双命中拿到 1.1 分）
    //
    // 当事人词提到 STRONG：它们才是"这件事和谁有关"的核心线索
    for (const w of ['妈', '爸', '父母', '家人', '奶奶', '爷爷']) {
      if (!seen.has(w)) add(w, W_STRONG);
    }
    // 注意：不要把「我」塞进触发词表 —— 它是泛词，会污染评分。
    // "今天去医院了" 这类"说话人自己在场"的判断放在 scoreTrigger 里做（见 selfPresent）。
  }
  const touchesLoss = /去世|走了|过世|离世/.test(s);
  if (touchesLoss) {
    for (const w of ['去世', '走了', '过世', '离开']) add(w, W_STRONG);
    for (const w of ['妈', '爸', '奶奶', '爷爷', '外婆', '外公', '家人']) {
      if (!seen.has(w)) add(w, W_WEAK);
    }
  }
  const touchesWork = /离职|辞职|工作|项目|公司/.test(s);
  if (touchesWork) {
    for (const w of ['工作', '公司', '项目', '离职', '辞职']) add(w, W_STRONG);
  }

  return out;
}

/**
 * 计算一轮发言对某个锚点的触发得分。
 *
 * @param {object} anchor
 * @param {string} text
 * @returns {{score: number, matched: string[], hit: boolean}}
 */
export function scoreTrigger(anchor, text) {
  const s = String(text ?? '');
  const triggers = anchor?.triggers ?? [];
  const matched = [];
  let score = 0;

  for (const t of triggers) {
    const word = typeof t === 'string' ? t : t?.w;
    const weight = typeof t === 'string' ? 0.5 : (t?.weight ?? 0.5);
    if (!word) continue;
    if (s.includes(word)) {
      score += weight;
      matched.push(word);
    }
  }

  /**
   * M4 组合判据（评分侧，不是建锚侧）。
   *
   * 场所词（医院/住院）单独命中只有 0.55，差一点点。但"说话人自己在场"
   * 足以补齐：「今天去医院了」是同一件事的延续。
   *
   * 排除「我朋友/我同事/我同学…」—— 那时"我"是定语不是当事人。
   * 这个判断必须看**当前文本**，不能在建锚时固化进词表
   * （试过那样做，结果所有含"我"的句子都被加 0.55）。
   */
  // 场所词单独 0.55 差一口气。两种情况该补齐：
  //   ① 有当事人词（妈/爸/奶奶…）—— 已在词表里，自然累加
  //   ② **场所词处于动作位置**（"去医院""住院了""出院了"）—— 说话人在讲经过
  //
  // 不该补齐的是**场所描述**（"医院附近的饭""医院好远""医院楼下"）：
  // 那里场所只是背景，不是事件。
  const PLACE_ACTION = /(去|在|到|回|来|住|出|办|跑)(了)?(一?趟)?(医院|病房|住院|复查|出院)|(医院|住院|病房|复查)(了|中)/;
  const PLACE_BACKGROUND = /(附近|旁边|楼下|周边|门口|食堂|路上|好远|很远|那边)/;
  const OTHER_SUBJECT = /朋友|同事|同学|邻居|室友|别人|他人/;

  if (PLACE_ACTION.test(s) && !PLACE_BACKGROUND.test(s) && !OTHER_SUBJECT.test(s)) {
    score += 0.55;
    matched.push('(事件)');
  }

  return { score: round(score), matched, hit: score >= TRIGGER_THRESHOLD };
}

/**
 * 从一段发言里提取锚点的摘要文本。
 *
 * 不做 NLP，只做截断与清理 —— 摘要的目的是让面板可读、让注入口语化，
 * 不需要精确概括（精确概括要调模型，成本不划算）。
 */
export function summarize(text, maxLen = 24) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length === 0) return '';

  /**
   * 锚点的摘要只保留**事件核心**，不含情绪表达。
   *
   * "我妈住院了，我有点撑不住" → 摘要应为「我妈住院了」，
   * 后半句是那次对话的情绪证据，存在 mentions 里就够了。
   *
   * 否则注入时会把整句话塞进提示词，读起来像数据库导出而不像回想。
   */
  const firstClause = s.split(/[，。！？；…]/)[0].trim();
  const core = firstClause.length > 0 ? firstClause : s;

  if (core.length <= maxLen) return core;
  return core.slice(0, maxLen) + '…';
}

/** 生成锚点 id */
export function makeAnchorId(now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 6);
  return `anc_${now}_${rand}`;
}

/**
 * 判断两条锚点是否是"同一件事"（用于合并，避免锚点泛滥）。
 *
 * 判据：kind 相同 且 有主导词重合。
 */
export function isSameTopic(a, b) {
  if (!a || !b) return false;
  if (a.state === 'resolved' || b.state === 'resolved') return false;

  const words = (x, minWeight) => (x.triggers ?? [])
    .filter((t) => (typeof t === 'string' ? 0.5 : (t?.weight ?? 0)) >= minWeight)
    .map((t) => (typeof t === 'string' ? t : t.w));

  // ① 主导词重叠（最可靠）
  const pa = new Set(words(a, W_PRIMARY));
  if (pa.size > 0 && words(b, W_PRIMARY).some((w) => pa.has(w))) return true;

  // ② 当事人词重叠（M4 修复的补充）
  //
  // 「住院」从主导词降级为强关联词后，两个关于同一个人健康事件的锚点
  // 不再能靠主导词合并：「我妈住院了」与「今天去医院了」都只剩强关联词。
  // 改为看**当事人词**是否重叠 —— 妈/爸/奶奶… 才是"这件事和谁有关"的身份锚。
  const SUBJECTS = ['妈', '爸', '父母', '家人', '奶奶', '爷爷', '外婆', '外公'];
  const sa = new Set(words(a, W_STRONG).filter((w) => SUBJECTS.includes(w)));
  if (sa.size === 0) return false;
  // 双方提到同一个人 + 都涉及健康/场所词 → 同一件事
  const PLACE_WORDS = ['医院', '住院', '病房', '复查', '出院', '身体'];
  const aHasPlace = words(a, W_STRONG).some((w) => PLACE_WORDS.includes(w));
  const bHasPlace = words(b, W_STRONG).some((w) => PLACE_WORDS.includes(w));
  return aHasPlace && bHasPlace && words(b, W_STRONG).some((w) => sa.has(w));
}

function round(v, d = 4) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
