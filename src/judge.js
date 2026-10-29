/**
 * 事件判定器：分层判定一轮发言是"什么事件"。
 *
 * 为什么要改（实测依据，2026-10-29）：
 *
 *   纯规则抽取在 20 条人工标注的真实中文上只有 **45%** 准确率。
 *   40 句日常口语里 **85%** 被判成 `distance`（负性事件），
 *   导致 200 轮日常聊天把 warmth 磨掉 0.41 —— 一个正常聊天的人被聊成另一个人。
 *
 *   同一标注集上 LLM 是 **75%**，且错误是"邻近类别"（intimacy↔support），
 *   不像规则那样方向性错误（"你真好" → distance）。
 *
 * 所以改为三层：
 *
 *   1. **规则筛子**：只识别高置信度的确定性信号（背叛/丧失/修复词），零成本放行
 *   2. **静默判定**：纯应声词（嗯/好的/晚安）直接判为 routine，不调 LLM
 *   3. **LLM 判定**：其余情况调用模型，带缓存与降级
 *
 * 降级策略：LLM 不可用（限流/超时/未配置）→ 退回规则结果。
 * 宁可准确率掉到 45%，也不让人格在限流期间停止工作。
 */

import { extractSignals, inferEventKind, calibrateValence } from './signals.js';
import { appraise } from './persona-core.js';

/** 判定结果的事件类型全集 */
export const KINDS = [
  'routine', 'distance', 'conflict', 'repair', 'support',
  'intimacy', 'achievement', 'betrayal', 'loss',
];

/**
 * 高置信度规则：命中即直接采用，不调 LLM。
 *
 * 这些是**字面即语义**的词——"我奶奶去世了"不需要模型判断是不是 loss。
 * 实测规则在这些词上准确率 100%，LLM 也是 100%，所以省掉调用。
 */
const CONFIDENT_RULES = [
  { kind: 'betrayal', re: /(骗|瞒着|背着我|出轨|抛弃|背叛|不告而别)/ },
  { kind: 'loss', re: /(去世|过世|不在了|走了|离世|分手|离婚)/ },
  { kind: 'repair', re: /(对不起|抱歉|是我不好|我错了|我说重了|原谅我)/ },
  // 明显负面情绪：模型实测会把"烦死了"误判成 intimacy，
  // 而 intimacy 是正效价，会往反方向推人格。这类词字面即语义，用规则兜住。
  { kind: 'conflict', re: /(烦死|气死|真烦|受够|忍不了|讨厌死|不想理你)/ },
  // 明确疏远意图
  { kind: 'distance', re: /(别管我|不想说|不想聊|让我静一静|算了不说了)/ },
];

/**
 * 静默词：纯应声/寒暄，不携带事件信息。
 *
 * **关键修正**：这类词以前被判成 `distance`（疏远）并给 -0.3 效价，
 * 这是"日常聊天磨坏人格"的主因。它们的真实含义是"本轮没有事件"，
 * 应该是 routine（中性、几乎不产生 strain）。
 */
const SILENT_WORDS = new Set([
  '嗯', '嗯嗯', '哦', '噢', '好的', '好', '行', '可以', '收到', '明白了', '懂了',
  '晚安', '早安', '早', '午安', '拜拜', '再见', '明天见', '先这样',
  '哈哈', '哈哈哈', '笑死', '确实', '是啊', '对', '是的', '没错',
  'ok', 'okay', '收到啦', '好嘞', '嗯呢', '在', '在吗',
  '哦', '噢', '喔', '诶', '嘿', '唔', '额', '呃',
]);

/**
 * 去掉标点，用于静默词匹配。
 *
 * 注意：**不要剥尾部语气词**。"哦"本身就是语气词，剥完就成空串了，
 * 反而匹配不到 —— 早期版本在这里踩过。
 * 语气词变体直接放进词表更可靠。
 */
function normalizeForSilent(text) {
  return String(text ?? '')
    .replace(/[，。！？、~…\s,.!?·]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * 规则筛选：返回确定的 kind，或 null 表示需要 LLM 判定。
 *
 * @param {string} text
 * @returns {{kind: string|null, reason: string}}
 */
export function ruleFilter(text) {
  const s = String(text ?? '').trim();
  if (s.length === 0) return { kind: 'routine', reason: 'empty' };

  // 1) 高置信度词
  for (const { kind, re } of CONFIDENT_RULES) {
    if (re.test(s)) return { kind, reason: `rule:${kind}` };
  }

  // 2) 纯应声词 → routine（不是 distance！）
  const norm = normalizeForSilent(s);
  if (norm.length > 0 && norm.length <= 4 && SILENT_WORDS.has(norm)) {
    return { kind: 'routine', reason: 'rule:silent' };
  }

  // 3) 极短句：交给 LLM，不预设情感倾向
  //
  //    这里**刻意不判 distance**，也不判 routine：
  //    "嗯"在敷衍和松弛里都成立，规则没有上下文，判不准。
  //    实测教训：旧代码把所有 ≤6 字短句判成 distance 并给 -0.3 效价，
  //    结果 200 轮日常聊天把 warmth 磨掉 0.41。
  //    短句不携带足够信息 → 让它走 LLM（有对话上下文），或至少不产生 strain。
  if (s.length <= 2) {
    return { kind: null, reason: 'needs-llm:too-short' };
  }

  return { kind: null, reason: 'needs-llm' };
}

const VALID_KIND = new Set(KINDS);

/**
 * 把 LLM 的自由输出收敛成合法标签。
 *
 * 模型可能输出 "conflict。" / "**repair**" / "标签：loss"，这里做容错。
 * 无法识别时返回 null，让调用方降级。
 */
export function parseKind(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/[*`"'。．，,：:\n\r]/g, ' ')
    .trim();
  // 精确命中
  if (VALID_KIND.has(cleaned)) return cleaned;
  // 包含命中：取第一个出现的合法标签
  for (const k of KINDS) {
    if (new RegExp(`(^|\\s)${k}(\\s|$)`).test(cleaned)) return k;
  }
  return null;
}

/** 判定用的系统提示词。刻意简短——只要标签，不要解释，省 token 也省延迟。 */
export const CLASSIFIER_PROMPT = `你是情感事件分类器。判断用户这句话属于哪一类。

标签（只能选一个）：
- routine      日常闲聊、寒暄、应答，没有明显情感色彩
- distance     对方在疏远、冷淡、回避（注意：短句不等于疏远）
- conflict     争执、不满、指责
- repair       道歉、和解、修复关系
- support      表达感谢、肯定、支持对方
- intimacy     自我暴露、示弱、分享私人情感或家庭私事
- achievement  分享好消息、成就、开心的事
- betrayal     欺骗、隐瞒、背叛、离开
- loss         失去、去世、分手、永别

只输出标签本身，不要解释，不要加标点。`;

/**
 * LLM 判定器。带 LRU 缓存与降级。
 *
 * @param {object} deps
 * @param {(text:string) => Promise<string|null>} deps.classify 调用模型的函数，返回原始文本
 * @param {number} [deps.cacheSize]
 * @param {object} [deps.logger]
 */
export function createJudge({ classify, cacheSize = 512, logger } = {}) {
  /** 归一化后的文本 → kind。高频短句会大量命中。 */
  const cache = new Map();
  const stats = { calls: 0, cacheHits: 0, ruleHits: 0, llmHits: 0, fallbacks: 0, failures: 0 };

  function cacheKey(text) {
    return String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
  }

  function remember(key, kind) {
    if (cache.size >= cacheSize) {
      // 简单的 FIFO 淘汰：Map 保序，删最早的
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(key, kind);
  }

  /**
   * 判定一条发言。
   * @param {string} text
   * @returns {Promise<{kind:string, source:'rule'|'cache'|'llm'|'fallback', reason:string}>}
   */
  async function judge(text) {
    // 第一层：规则筛子
    const filtered = ruleFilter(text);
    if (filtered.kind) {
      stats.ruleHits++;
      return { kind: filtered.kind, source: 'rule', reason: filtered.reason };
    }

    // 缓存
    const key = cacheKey(text);
    if (cache.has(key)) {
      stats.cacheHits++;
      return { kind: cache.get(key), source: 'cache', reason: 'cached' };
    }

    // LLM
    stats.calls++;
    try {
      const raw = await classify(key);
      const kind = parseKind(raw);
      if (kind) {
        stats.llmHits++;
        remember(key, kind);
        return { kind, source: 'llm', reason: 'model' };
      }
      stats.failures++;
      logger?.warn?.(`[persona] 模型输出无法识别为标签: ${String(raw).slice(0, 40)}`);
    } catch (err) {
      stats.failures++;
      logger?.warn?.(`[persona] 事件判定失败，降级为规则: ${String(err?.message ?? err).slice(0, 100)}`);
    }

    // 降级：规则兜底
    stats.fallbacks++;
    const fallbackKind = inferEventKind(extractSignals(key), key) ?? 'routine';
    return { kind: fallbackKind, source: 'fallback', reason: 'llm-unavailable' };
  }

  return { judge, stats, clearCache: () => cache.clear() };
}

/**
 * 把判定结果 + 文本转成可用于动力学的事件参数。
 *
 * 效价由事件类型给下限（calibrateValence），文本情感只能抬高不能压低。
 * 这条规则在真实数据上验证过：没有它，纯冲突文本效价为 0，
 * strain 恒为 0，人格永不变化。
 */
export function toEpisode(kind, text) {
  const sig = extractSignals(text);
  const valence = calibrateValence(kind, sig);
  // 直接返回 appraise() 的产物 —— 它才是 step() 的入参。
  // 早期版本返回裸参数，调用方忘了包一层 appraise 就得到 load=NaN，
  // 而 NaN 会静默污染整个状态（比较运算全部为 false，不报错）。
  return appraise({
    kind,
    relevance: sig.relevance,
    valence,
    novelty: sig.novelty,
    agency: sig.agency,
    text,
  });
}
