/**
 * LLM 用量统计：只统计**本插件自己**发起的调用。
 *
 * ## 为什么需要单独统计
 *
 * 人格插件的每轮对话会额外调一次模型做事件判定（judge），锚点解决检测还会再调。
 * 这些用量混在 DSH 的全局统计里，看不出"人格功能到底花了多少"。
 *
 * ## 统计什么
 *
 * 从 `ctx.llm.stream()` 收到的 `{ type: 'usage', usage }` chunk：
 *   - inputTokens  输入（含系统提示）
 *   - outputTokens 输出
 *   - totalTokens  总计（适配器可能不给，用前两项相加兜底）
 *
 * 按用途分桶（judge / anchor-resolve），便于看出哪部分花得多。
 *
 * ## 不做什么
 *
 * - 不做价格换算（各 provider 定价不同，硬编码会过期）
 * - 不持久化到磁盘（重启归零，避免状态文件膨胀）
 *
 * @module usage
 */

/** 分桶键 */
export const USAGE_BUCKETS = ['judge', 'anchor-resolve'];

/**
 * 创建一个统计器。
 *
 * @param {object} [options]
 * @param {number} [options.maxRecent] 保留多少条最近记录
 */
export function createUsageMeter({ maxRecent = 50 } = {}) {
  const buckets = {};
  for (const b of USAGE_BUCKETS) {
    buckets[b] = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, failures: 0, lastAt: null };
  }

  /** 最近 N 次调用（供面板展示趋势） */
  const recent = [];

  const totals = {
    calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, failures: 0,
    startedAt: Date.now(),
  };

  /**
   * 记录一次调用。
   *
   * @param {string} bucket 用途分桶
   * @param {object|null} usage TokenUsage（可能为 null，表示适配器没给）
   * @param {object} [meta] { ok, ms, model }
   */
  function record(bucket, usage, meta = {}) {
    const b = buckets[bucket] ?? (buckets[bucket] = {
      calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, failures: 0, lastAt: null,
    });

    const input = Number(usage?.inputTokens ?? 0) || 0;
    const output = Number(usage?.outputTokens ?? 0) || 0;
    const total = Number(usage?.totalTokens ?? 0) || (input + output);

    b.calls += 1;
    b.inputTokens += input;
    b.outputTokens += output;
    b.totalTokens += total;
    b.lastAt = Date.now();
    if (meta.ok === false) b.failures += 1;

    totals.calls += 1;
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.totalTokens += total;
    if (meta.ok === false) totals.failures += 1;

    recent.unshift({
      at: Date.now(),
      bucket,
      input,
      output,
      total,
      ok: meta.ok !== false,
      ms: meta.ms ?? null,
      model: meta.model ?? null,
      /** 适配器没给 usage 时标记，便于发现"统计不到"的情况 */
      missing: usage == null,
    });
    if (recent.length > maxRecent) recent.length = maxRecent;
  }

  /** 快照，供面板读取。 */
  function snapshot() {
    const perBucket = {};
    for (const [k, v] of Object.entries(buckets)) {
      perBucket[k] = { ...v };
    }
    return {
      totals: { ...totals, uptimeMs: Date.now() - totals.startedAt },
      buckets: perBucket,
      recent: recent.slice(0, 20),
    };
  }

  function reset() {
    for (const k of Object.keys(buckets)) {
      buckets[k] = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, failures: 0, lastAt: null };
    }
    recent.length = 0;
    for (const k of Object.keys(totals)) {
      if (k === 'startedAt') totals[k] = Date.now();
      else totals[k] = 0;
    }
  }

  return { record, snapshot, reset };
}

/**
 * 包装一次流式调用，自动捕获 usage。
 *
 * 用法：
 * ```js
 * const out = await collectStream(chunks, (usage) => meter.record('judge', usage, {...}));
 * ```
 *
 * @param {AsyncIterable} chunks ctx.llm.stream() 的返回
 * @param {(usage: object|null) => void} onUsage 收到 usage 时回调（结束时总会调用一次）
 * @returns {Promise<string>} 拼好的文本
 */
export async function collectStream(chunks, onUsage) {
  let out = '';
  let usage = null;
  try {
    for await (const chunk of chunks) {
      if (chunk?.type === 'text-delta') out += chunk.text;
      else if (chunk?.type === 'usage') usage = chunk.usage;
    }
  } finally {
    // 无论成功失败都回调一次：失败时 usage 为 null，便于统计"没拿到用量"的调用
    onUsage?.(usage);
  }
  return out;
}
