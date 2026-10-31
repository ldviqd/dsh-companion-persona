/**
 * 解决检测：判断一轮发言是「那件事怎么样了」。
 *
 * 这是锚点三态状态机的关键一环。没有它，`open` 的锚点永远悬着 ——
 * 三个月后提起来，模型仍会说"她母亲在住院"，而实际上早就出院了。
 *
 * 判定分三层，成本从低到高：
 *   1. 高置信规则（出院/康复/没事了）—— 零成本，直接转态
 *   2. 延续规则（还在/复发）—— 零成本，保持 open
 *   3. 其余 → 交给模型判定，失败则不转态（宁可不动，不可乱动）
 */

/** 高置信解决语：这些词出现基本可以确定事情过去了 */
const RESOLVED_RE = /(出院|康复|痊愈|好多了|好转|已经好了|病好了|手术成功|没事了|挺过来了|度过了|解决了|处理完了|都过去了|已经过去)/;

/** 高置信延续语：明确表示还在进行中 */
const CONTINUING_RE = /(还在|仍在|继续|再次|又犯|复发|住院中|又住院|没好转|加重|恶化|不太好)/;

/** 判定结果 */
export const RESOLVE_KINDS = ['resolved', 'continuing', 'unknown'];

/**
 * 规则判定。返回 'resolved' | 'continuing' | null(null = 需模型)
 *
 * 顺序很重要：先判延续，因为「还没好转」同时含"好转"和"没"，先判解决会误判。
 */
export function ruleResolve(text) {
  const s = String(text ?? '');
  if (s.trim().length === 0) return 'unknown';

  // 延续优先：避免"没好转""还在住院"被解决规则误伤
  if (CONTINUING_RE.test(s)) return 'continuing';

  if (RESOLVED_RE.test(s)) return 'resolved';

  return 'unknown';
}

/** 判定用的提示词。极短——只要一个标签。 */
export const RESOLVE_PROMPT = `判断「这次发言」与「之前那件事」的关系。

之前那件事：{ANCHOR}

只输出下面三个标签之一，不要解释：
- resolved   这件事已经结束/好转了（如"出院了""解决了""过去了"）
- continuing 这件事还在进行（如"还在住院""又犯了"）
- unrelated  只是提到了相关的人或词，但不是同一件事的进展

只输出标签本身。`;

/** 解析模型输出 */
export function parseResolveKind(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.toLowerCase().replace(/[*`"'。．，,：:\n\r]/g, ' ').trim();
  for (const k of RESOLVE_KINDS) {
    if (new RegExp(`(^|\\s)${k}(\\s|$)`).test(cleaned)) return k;
  }
  return null;
}

/**
 * 从发言里提取解决备注（用于面板展示"后来怎么样了"）。
 * 只是一个短摘要，不需要精确。
 */
export function resolveNote(text, maxLen = 20) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const first = s.split(/[，。！？；…]/)[0].trim() || s;
  return first.length <= maxLen ? first : `${first.slice(0, maxLen)}…`;
}

/**
 * 判断一轮发言是否与某个锚点相关（用于决定要不要跑解决检测）。
 *
 * 用与触发相同的权重机制，但阈值降低 —— 这里只想知道"是否在聊这件事"，
 * 不需要强到"该注入回忆"的程度。
 */
export function isRelatedToAnchor(scoreResult, minScore = 0.4) {
  return (scoreResult?.score ?? 0) >= minScore;
}
