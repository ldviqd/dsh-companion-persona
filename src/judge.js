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

import { extractSignals, inferEventKind, calibrateValence, applyKindRelevance } from './signals.js';
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
  // '再见'/'拜拜' 刻意不收：可能是告别事件（长期不联系），不该零成本静默
  '晚安', '早安', '早', '午安', '明天见', '先这样',
  '哈哈', '哈哈哈', '笑死', '确实', '是啊', '对', '是的', '没错',
  // '在吗' 是询问不是寒暄，交给 LLM 判（可能是一次重要对话的开场）
  'ok', 'okay', '收到啦', '好嘞', '嗯呢', '在',
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
/**
 * 从模型输出里同时解析 kind 与 valence。
 *
 * 兼容两种格式：
 *   新：`kind=achievement\nvalence=0.8`
 *   旧：只输出标签（退回 parseKind，valence 为 null）
 *
 * valence 解析失败不影响 kind —— 两者独立降级。
 *
 * @returns {{kind: string|null, valence: number|null}}
 */
export function parseJudgement(raw) {
  if (typeof raw !== 'string') return { kind: null, valence: null };

  // kind 优先取 `kind=xxx` 显式标注 —— 否则 parseKind 会被前缀词 "kind" 干扰
  // （它把 = 换成空格后，"kind achievement" 里 "kind" 会先被当成候选）
  const labeledKind = raw.match(/kind\s*[=:]\s*([a-z]+)/i);
  const kind = labeledKind
    ? (VALID_KIND.has(labeledKind[1].toLowerCase()) ? labeledKind[1].toLowerCase() : parseKind(raw))
    : parseKind(raw);

  // 优先取 `valence=` 显式标注；没有则退回"文本里唯一的数字"
  let valence = null;
  const labeled = raw.match(/valence\s*[=:]\s*(-?\d+(?:\.\d+)?)/i);
  const numMatch = labeled ?? raw.match(/(?:^|\s)(-?\d+\.\d+)(?:\s|$)/);
  if (numMatch) {
    const v = parseFloat(numMatch[1]);
    if (Number.isFinite(v)) valence = Math.max(-1, Math.min(1, v));
  }
  return { kind, valence };
}

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
export const CLASSIFIER_PROMPT = `判断这句话的事件类型和情感效价。

类型（选一个）：
routine 闲聊寒暄 / distance 疏远冷淡 / conflict 争执不满 / repair 道歉和解
support 感谢肯定 / intimacy 示弱或分享私事 / achievement 好消息好心情
betrayal 欺骗背叛 / loss 失去永别

效价：-1 到 1 的小数。-1 极度负面，0 中性，1 极度正面。

判断效价时注意：
- 反讽：「你可真行啊」「真是谢谢你啊」是负面
- 亲昵的骂：「讨厌啦」「你这个笨蛋」可能偏正面
- 敷衍：「行吧」「随你」「哦」轻微负面
- 陈述里出现情感词（"这本书讲怎么应对焦虑"）不算负面
- 短句不等于疏远

只输出两行，不要解释：
kind=类型
valence=数字`;

/**
 * LLM 判定器。带缓存与降级。
 *
 * 缓存策略是**真 LRU**：命中时把键移到队尾，淘汰时删队首。
 * （0.2.0 的注释写成 LRU 但实现是 FIFO —— 命中不刷新位置，审计报告指出过。）
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

  function remember(key, kind, valence = null) {
    if (cache.size >= cacheSize) {
      // 简单的 FIFO 淘汰：Map 保序，删最早的
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(key, { kind, valence });
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
      // 真 LRU：命中后移到队尾，让热点条目不容易被淘汰
      const hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit);
      // 兼容早期只存 kind 字符串的条目
      const cachedKind = typeof hit === 'string' ? hit : hit.kind;
      const cachedValence = typeof hit === 'string' ? null : hit.valence;
      return { kind: cachedKind, valence: cachedValence, source: 'cache', reason: 'cached' };
    }

    // LLM
    stats.calls++;
    try {
      const raw = await classify(key);
      const { kind, valence } = parseJudgement(raw);
      if (kind) {
        stats.llmHits++;
        remember(key, kind, valence);
        // valence 与 kind 一起返回：模型已经读过这句话了，顺带给出效价，
        // 比让词典再猜一遍准得多（实测 MAE 0.141 vs 0.453）。
        return { kind, valence, source: 'llm', reason: 'model' };
      }
      stats.failures++;
      logger?.warn?.(`[persona] 模型输出无法识别为标签: ${String(raw).slice(0, 40)}`);
    } catch (err) {
      stats.failures++;
      logger?.warn?.(`[persona] 事件判定失败，降级为规则: ${String(err?.message ?? err).slice(0, 100)}`);
    }

    // 降级：规则兜底
    //
    // 注意 inferEventKind 的老毛病：它把大量短句和中性句判成 distance。
    // 限流时如果直接用它，人格会被错误地往负面推 —— 比停摆更糟。
    // 所以降级路径**先过一遍保守规则**，只在明确负性时才接受 distance。
    stats.fallbacks++;
    const fallbackKind = conservativeFallback(key);
    return { kind: fallbackKind, source: 'fallback', reason: 'llm-unavailable' };
  }

  return { judge, stats, clearCache: () => cache.clear() };
}

/** 正向信号：降级路径用，避免把好事判成疏远 */
const POSITIVE_HINTS = /(开心|高兴|喜欢|谢谢|感谢|真好|太好了|不错|顺利|成功|升职|通过|搞定|完成|赢了|幸福|满足|安心|放心|暖)/;
/** 负向信号：只在明确负性时接受 distance */
const NEGATIVE_HINTS = /(难过|累|烦|压力|焦虑|担心|害怕|失望|生气|讨厌|崩溃|委屈|难受|撑不住|失眠|孤独|寂寞)/;

/**
 * 保守降级：LLM 不可用时的规则兜底。
 *
 * 设计原则是**宁可判 routine，也不误判成负性**。
 * 因为 routine 几乎不产生 strain（magnitude ≤ 0.109），
 * 而误判 distance 会持续消耗人格——错一次没影响，错一百次就是另一个人。
 */
function conservativeFallback(text) {
  const s = String(text ?? '');

  // 1) 明确的冲突指向优先（"你"字从句），先于情绪词判断
  if (/(你根本|你总是|你从来|你不懂|你又不|凭什么)/.test(s)) return 'conflict';

  // 2) 亲密话题：家人/身体/私事。
  //    亲密**先于**负面情绪判断 —— "我妈住院了我很难过"是示弱不是冲突。
  if (/(妈|爸|父母|家人|奶奶|爷爷|外婆|外公|弟|妹|哥|姐|住院|生病|手术|身体|去世)/.test(s)) {
    return 'intimacy';
  }

  // 3) 示弱表达：向对方暴露脆弱本身就是靠近，不是冲突。
  //    这是审计报告指出的方向性错误："我其实很害怕" 被判成 conflict（负效价），
  //    等于用户越示弱、AI 越戒备。
  //    正则要点：副词可叠加（"我其实**很**害怕"是四段），所以用 [^。，]{0,4} 松散匹配，
  //    而不是硬编码"我+副词+情绪词"三段式 —— 后者会漏掉最常见的说法。
  if (/(我[^。，！？]{0,5}(害怕|担心|难过|委屈|孤单|想哭|撑不住|不敢|后悔|焦虑))/.test(s)
      || /(说实话|老实说|说真的)/.test(s)) {
    return 'intimacy';
  }

  if (POSITIVE_HINTS.test(s)) return 'achievement';

  if (NEGATIVE_HINTS.test(s)) {
    if (/(别管|不想说|不想聊|让我静一静)/.test(s)) return 'distance';
    return 'conflict';
  }

  // 4) 修复语
  if (/(我们聊聊|好吗|对不起|抱歉)/.test(s)) return 'repair';

  // 无明确情感信号 → routine（中性，不消耗人格）
  return 'routine';
}

/**
 * 把判定结果 + 文本转成可用于动力学的事件参数。
 *
 * 效价由事件类型给下限（calibrateValence），文本情感只能抬高不能压低。
 * 这条规则在真实数据上验证过：没有它，纯冲突文本效价为 0，
 * strain 恒为 0，人格永不变化。
 */
/**
 * 调和模型给出的 valence 与事件类型。
 *
 * 旧逻辑 calibrateValence 是「按 kind 强推下限」，用于修正**词典漏判**：
 * 词典算"你骗了我" = 0，才需要按 betrayal 强推到 -0.85。
 *
 * 模型给的 valence 已经理解了语义，再强推就是不信任它。实测：
 * 「不愧是你」模型给 +0.5（对），但 kind 若被判成 distance，
 * 强推会把答案改成 -0.30（错）。
 *
 * 所以只在方向相反时介入，同向的一律尊重模型。
 */
export function reconcileValence(kind, valence) {
  // intimacy 刻意不在此表：它**两种极性都合法** ——
  // 「谢谢你陪着我」是正效价的亲密，「我最近有点慌」是负效价的示弱。
  // 早期版本给 intimacy 一个 +0.1 下限，会把示弱强行判成正面，
  // 而示弱恰恰是锚点系统最关心的信号（ANCHOR_KINDS 含 intimacy）。
  const FLOOR = {
    betrayal: -0.5, loss: -0.6, conflict: -0.25, distance: -0.15,
    repair: 0.2, support: 0.25, achievement: 0.15,
  };
  const floor = FLOOR[kind];
  if (floor === undefined) return valence;
  if (floor < 0 && valence <= 0) return valence;
  if (floor > 0 && valence >= 0) return valence;
  return floor;
}

export function toEpisode(kind, text, llmValence = null) {
  // 先补事件类型带来的相关性下限，再算 valence/novelty —— 顺序很重要
  let sig = extractSignals(text);
  sig = applyKindRelevance(sig, kind);
  // valence 来源优先级：模型 > 词典
  //
  // 模型判定比词典准得多（实测 MAE 0.141 vs 0.453）—— 反讽、亲昵的骂、
  // 网络用语、示弱漏检这几类词典基本无能为力。
  // 但模型可能给出与 kind 矛盾的效价，交给 reconcileValence 处理，
  // 而不是像旧逻辑那样无条件按 kind 强推。
  let valence;
  if (typeof llmValence === 'number' && Number.isFinite(llmValence)) {
    sig = { ...sig, valence: llmValence };
    valence = reconcileValence(kind, llmValence);
  } else {
    valence = calibrateValence(kind, sig);
  }

  /**
   * 修正 novelty 的计算顺序。
   *
   * 原实现用**校正前**的 valence 算 novelty（在 signals.js 里），
   * 而 calibrateValence 是在这里才把背叛校正为 −0.85。
   * 后果：一句"你骗了我"原始 valence=0，拿不到「强情感」那 0.3 分，
   * novelty 只有 0.15 → shock = 0.85×0.38×0.15 = 0.049，差门槛 10 倍。
   *
   * 实测：连续 5 次背叛 load 都堆到 1.38 了，shock 恒为 0.049，永不突变。
   * 也就是说这个插件最有设计感的功能在真实文本上是死的。
   *
   * 这里用**校正后**的 valence 重算，让"这句话有多重"真正进入 novelty。
   */
  const novelty = Math.min(1,
    (text.length > 60 ? 0.4 : 0.15)
      + (Math.abs(valence) > 0.5 ? 0.3 : 0)
      + (sig.selfDisclosure >= 0.75 ? 0.3 : 0));

  return appraise({
    kind,
    relevance: sig.relevance,
    valence,
    novelty,
    agency: sig.agency,
    text,
  });
}
