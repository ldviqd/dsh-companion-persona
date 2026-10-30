/**
 * 信号抽取：把一段用户发言转成可驱动人格的评分维度。
 *
 * 设计取舍：**不用 LLM 打分**。
 *
 * 理由：
 * 1. 每轮都调 LLM 会持续烧 token，且限流时人格直接停摆；
 * 2. 规则可回放、可 diff、零成本；
 * 3. 陪伴场景的信号大多是**结构性的**（长度、提问、自我暴露标记），规则足够。
 *
 * 局限（诚实标注）：情感识别的精度有限。规则会在反讽、克制表达上失手。
 * 这是有意的取舍——宁可人格变化慢一点，也不让它在限流时失语。
 */

/** 情绪词表（简版，按中文常见表达） */
const POSITIVE = [
  '开心', '高兴', '喜欢', '谢谢', '太好了', '不错', '舒服', '顺利', '成功',
  '有趣', '喜欢', '好喜欢', '爱', '暖', '放心', '安心', '期待', '很棒', '赞',
  '哈哈', '嘿嘿', '嘻嘻', '笑', '幸福', '满足',
];

const NEGATIVE = [
  '难过', '累', '烦', '压力', '焦虑', '担心', '害怕', '失望', '生气', '讨厌',
  '崩', '痛', '哭', '孤独', '寂寞', '委屈', '难受', '不行', '撑不住', '崩溃',
  '烦死', '郁闷', '心累', 'emo', '糟糕', '失败', '失眠', '讨厌',
];

/** 自我暴露标记：从"事实"到"脆弱"四级递进（Social Penetration） */
const DISCLOSURE_FACT = ['我', '我的', '我在', '我是'];
const DISCLOSURE_EVAL = ['我觉得', '我认为', '我感觉', '我想', '我看', '对我来说'];
const DISCLOSURE_EMOTION = ['我很', '我好', '我特别', '我有点', '我有些', '我太'];
const DISCLOSURE_VULNERABLE = [
  '我害怕', '我担心', '我其实', '说实话', '老实说', '我不敢', '我不想让人知道',
  '我从来没', '我一直', '我真的', '我后悔', '我恨', '我羞',
];

/** 冲突标记 */
const CONFLICT = [
  '你根本', '你总是', '你从来', '你又不', '凭什么', '烦死', '算了', '不想说',
  '别管我', '滚', '你很', '你能不能', '为什么你',
];

/** 修复标记 */
const REPAIR = [
  '对不起', '抱歉', '是我不好', '我错了', '我理解', '我们聊聊', '别生气',
  '我说重了', '原谅', '重新', '没事的', '我改',
];

/** 亲密话题域 */
const INTIMATE_TOPICS = [
  // 家人：必须覆盖"我+亲属"的常见省略写法（"我妈"而非"妈妈"）
  '家人', '父母', '妈', '爸', '弟', '妹', '哥', '姐', '奶奶', '爷爷', '外婆', '外公',
  // 情感
  '感情', '恋爱', '分手', '前任', '喜欢的人', '暗恋',
  // 身体与健康
  '身体', '生病', '住院', '医院', '手术', '复查', '病',
  // 私领域
  '童年', '小时候', '钱', '工资', '房贷', '存款', '梦', '去世', '离开', '孤独',
];

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function countHits(text, words) {
  let n = 0;
  for (const w of words) if (text.includes(w)) n++;
  return n;
}

/**
 * 抽取一轮信号。
 *
 * @param {string} text 用户本轮发言
 * @returns {{relevance:number, valence:number, novelty:number, agency:number,
 *            selfDisclosure:number, conflict:number, repair:number,
 *            engagement:number, topicIntimacy:number, confidence:number}}
 */
/**
 * 高相关事件类型：这些事**天然**与"我和这个人之间"强相关，不需要靠字数或
 * 情感词来证明。
 *
 * 修的是一个语义错误：原 relevance 只用 长度/亲密词/自我暴露 来算，
 * 于是 4 个字的"你骗了我"拿到 relevance=0.40 —— 算法认为"这事跟你关系不大"。
 * 但被亲近的人背叛恰恰是最相关的事之一。
 *
 * 结果：magnitude 被压到 0.41，shock 只有 0.159，突变永远够不到门槛。
 */
export const HIGH_RELEVANCE_KINDS = {
  betrayal: 0.85,
  loss: 0.85,
  conflict: 0.55,
  repair: 0.60,
  intimacy: 0.65,
};

/**
 * 给信号补一个"按事件类型"的相关性下限。
 *
 * 在 judge 判定出 kind 之后调用，因为 signals.js 自己不知道 kind。
 */
export function applyKindRelevance(sig, kind) {
  const floor = HIGH_RELEVANCE_KINDS[kind];
  if (floor === undefined) return sig;
  return { ...sig, relevance: Math.max(sig.relevance, floor) };
}

export function extractSignals(text) {
  const s = String(text ?? '').trim();
  if (s.length === 0) {
    return {
      relevance: 0, valence: 0, novelty: 0, agency: 0.5,
      selfDisclosure: 0, conflict: 0, repair: 0,
      engagement: 0, topicIntimacy: 0, confidence: 0,
    };
  }

  // --- 效价：正负词频差分，除以 sqrt(len) 抑制长文本 ---
  const pos = countHits(s, POSITIVE);
  const neg = countHits(s, NEGATIVE);
  // 否定词翻转（"不开心" 不该算正面）
  const negated = /不(开心|高兴|喜欢|舒服|顺利|好)/.test(s) ? 1 : 0;
  const raw = (pos - neg - negated) / Math.sqrt(Math.max(s.length, 1));
  const valence = Math.max(-1, Math.min(1, raw * 3));

  // --- 自我暴露深度：四级递进 ---
  let disclosure = 0;
  if (countHits(s, DISCLOSURE_FACT) > 0) disclosure = 0.25;
  if (countHits(s, DISCLOSURE_EVAL) > 0) disclosure = 0.50;
  if (countHits(s, DISCLOSURE_EMOTION) > 0) disclosure = 0.75;
  if (countHits(s, DISCLOSURE_VULNERABLE) > 0) disclosure = 1.00;

  // --- 冲突 / 修复 ---
  const conflict = clamp01(countHits(s, CONFLICT) * 0.4);
  const repair = clamp01(countHits(s, REPAIR) * 0.5);

  // --- 话题亲密性 ---
  const intimate = clamp01(countHits(s, INTIMATE_TOPICS) * 0.4);

  // --- 投入度：长度 + 提问 + 追问 ---
  const questions = (s.match(/[？?]/g) ?? []).length;
  const lengthScore = clamp01(s.length / 80);
  const engagement = clamp01(lengthScore * 0.6 + clamp01(questions * 0.3) * 0.4);

  // --- 相关性：私事比事务性更重要；有情感词说明在意 ---
  const relevance = clamp01(
    0.35 + 0.30 * intimate + 0.20 * disclosure + 0.15 * Math.abs(valence),
  );

  // --- 新颖性：罕见表达 / 长文本 / 明显情绪转折。规则难判，保守取值 ---
  const novelty = clamp01(
    (s.length > 60 ? 0.4 : 0.15)
      + (Math.abs(valence) > 0.5 ? 0.3 : 0)
      + (disclosure >= 0.75 ? 0.3 : 0),
  );

  // --- 置信度：信息量太少时降低，让上层可以折扣 ---
  const confidence = clamp01(0.35 + s.length / 100 + (pos + neg > 0 ? 0.2 : 0));

  return {
    relevance,
    valence: round(valence),
    novelty: round(novelty),
    agency: 0.5,
    selfDisclosure: disclosure,
    conflict: round(conflict),
    repair: round(repair),
    engagement: round(engagement),
    topicIntimacy: round(intimate),
    confidence: round(confidence),
  };
}

/**
 * 把信号归类成事件类型（驱动人格动力学的 kind）。
 *
 * 优先级：冲突 > 修复 > 脆弱暴露 > 亲密 > 支持 > 其他。
 * 冲突必须最先判断——否则一句"你总是这样，但我也理解"会被误判为 repair。
 */
export function inferEventKind(signals, text) {
  const s = String(text ?? '');

  // 背叛语义优先：它可能不带冲突词（"你背着我做了决定"），但绝不能漏判。
  // 漏判的代价是人格把背叛当日常，方向完全错。
  if (/骗|瞒着|背着我|出轨|离开我|抛弃|背叛|不告而别/.test(s)) return 'betrayal';

  // 丧失语义同样优先：在 conflict 判断之前，避免"分离"被归为普通吵架。
  if (/去世|不在了|走了|分手|离婚|失去|离开我|过世/.test(s)) return 'loss';

  if (signals.conflict >= 0.4) return 'conflict';
  if (signals.repair >= 0.5) return 'repair';

  // 亲密只在**有亲密话题**时成立；单纯的自我暴露（"我好开心"）不算亲密。
  // 早期版本用 selfDisclosure>=0.75 就判亲密，导致"面试通过"被当成亲密事件。
  if (signals.topicIntimacy >= 0.4 && signals.selfDisclosure >= 0.5) return 'intimacy';
  // 高脆弱暴露 + 未涉及亲密话题 → 仍是亲密（向对方示弱本身就是靠近）
  if (signals.selfDisclosure >= 1.0) return 'intimacy';
  if (signals.valence > 0.3) {
    if (signals.conflict === 0 && /谢|你真好|喜欢你|抱抱/.test(s)) return 'support';
    return 'achievement';
  }
  // 疏远信号：冷淡、短回复
  if (s.length <= 6 && signals.engagement < 0.2) return 'distance';
  if (signals.valence < -0.2) return 'distance';

  return 'routine';
}

/**
 * 按事件类型校正效价。
 *
 * 必要性：词表只能捕捉**显式**情绪词。但"你根本不懂我在说什么"没有任何负面词，
 * 效价算出来是 0 —— 于是 strain = magnitude × max(0, -valence) = 0，
 * 冲突完全不积累负荷，人格永远不变（实测 22 轮对话零变化）。
 *
 * 事件类型本身携带情感基调：冲突/背叛/丧失天然是负性的，修复/支持天然是正性的。
 * 这里给一个**下限**（不是覆盖）：若词表算出更强的值，保留原来的。
 */
export function calibrateValence(kind, signals) {
  const v = signals.valence;
  switch (kind) {
    case 'betrayal': return v > -0.7 ? -0.85 : v;
    case 'loss': return v > -0.8 ? -0.9 : v;
    case 'conflict': return v > -0.35 ? -0.45 : v;
    case 'distance': return v > -0.2 ? -0.3 : v;
    case 'repair': return v < 0.3 ? 0.4 : v;
    case 'support': return v < 0.3 ? 0.5 : v;
    case 'intimacy': return v < 0.1 ? 0.25 : v;
    case 'achievement': return v < 0.2 ? 0.45 : v;
    default: return v;
  }
}

function round(v, d = 4) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
