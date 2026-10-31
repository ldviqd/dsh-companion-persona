/**
 * 锚点持久化与生命周期管理。
 *
 * 与 state.json 分离存储：锚点是 append-mostly 的数据，人格状态是每轮改写的。
 * 混在一起会让每次人格更新都重写整个锚点库（可能几十条），IO 放大。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ANCHOR_STATES, shouldCreateAnchor, buildTriggers, scoreTrigger,
  summarize, makeAnchorId, isSameTopic,
} from './anchor.js';
import { ruleResolve, resolveNote, isRelatedToAnchor } from './anchor-resolve.js';

const MAX_ANCHORS = 200;
/** 注入冷却：同一锚点这段时间内不重复注入 */
export const RECALL_COOLDOWN_MS = 60 * 60 * 1000;
/** 一次最多注入几条，多了就变成数据库倾倒 */
export const MAX_INJECT = 3;
/** 每次被回忆后权重轻微下降，避免同一件事反复被想起 */
const WEIGHT_DECAY_PER_RECALL = 0.98;

/**
 * 淡出规则。
 *
 * 设计意图：不是"清理垃圾"，是模拟记忆的自然沉降。
 * 一件解决了的事长期不提，就不该再主动涌上来 —— 但如果再次被提到，可以复活。
 *
 * 两条同时满足才淡出：
 *   1. 超过 fadeAfterDays 天没被提及
 *   2. 权重低于 fadeWeightBelow
 *
 * 为什么两个条件都要：只看时间会让重要的事被埋掉（"奶奶去世"一年不提也该记住）；
 * 只看权重会让刚发生的小事立刻沉下去。
 */
export const FADE_AFTER_DAYS = 365;
export const FADE_WEIGHT_BELOW = 0.40;
/** 已解决的锚点可以更早淡出 —— 事情过去了，不必一直占着 */
export const FADE_RESOLVED_AFTER_DAYS = 90;

/** 读锚点库。容忍文件缺失与损坏。 */
export async function loadAnchors(file) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.anchors)) return parsed.anchors;
    return [];
  } catch {
    return [];
  }
}

/** 原子写 */
export async function saveAnchors(file, anchors) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = { version: 1, updatedAt: Date.now(), anchors: anchors.slice(-MAX_ANCHORS) };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * 根据一轮事件决定是否新建锚点。
 *
 * @returns {object|null} 新锚点，或 null
 */
export function maybeCreateAnchor(existing, { kind, signals, episode, text, at }) {
  const verdict = shouldCreateAnchor(kind, signals, text);
  if (!verdict.should) return null;

  // 同主题合并：同一件事反复提，不该产生一堆锚点
  const triggers = buildTriggers(kind, text);
  const candidate = { kind, triggers, state: 'open' };
  const same = existing.find((a) => isSameTopic(a, candidate));
  if (same) {
    // 不新建，只追加一次提及
    same.mentions.push({ at, excerpt: summarize(text, 80) });
    return null;
  }

  return {
    id: makeAnchorId(at),
    summary: summarize(text),
    when: at,
    kind,
    weight: round(Math.min(1, Math.abs(episode.valence) * episode.magnitude * 1.6) + 0.25),
    valence: episode.valence,
    state: 'open',
    resolvedAt: null,
    resolutionNote: null,
    triggers,
    mentions: [{ at, excerpt: summarize(text, 80) }],
    recalledCount: 0,
    lastRecalledAt: null,
  };
}

/**
 * 找出本轮该注入的锚点。
 *
 * 排序依据：匹配得分 × 权重 × 新鲜度。取前 MAX_INJECT 条。
 */
export function selectRecall(anchors, text, now = Date.now()) {
  const out = [];
  for (const a of anchors) {
    if (!a || a.state === 'faded') continue;
    // 冷却期内不重复注入
    if (a.lastRecalledAt && now - a.lastRecalledAt < RECALL_COOLDOWN_MS) continue;

    const { hit, score, matched } = scoreTrigger(a, text);
    if (!hit) continue;

    out.push({ anchor: a, score, matched, rank: score * (a.weight ?? 0.5) });
  }
  out.sort((x, y) => y.rank - x.rank);
  return out.slice(0, MAX_INJECT);
}

/**
 * 处理"这件事怎么样了"。
 *
 * 对每个 open 的锚点：如果本轮发言与它相关，判定是 resolved / continuing / unrelated。
 * 只有 resolved 才转态；continuing 什么都不做（保持 open）；unrelated 也什么都不做。
 *
 * **宁可不动，不可乱动**：误把 open 改成 resolved，那段记忆就再也不会被想起来了。
 *
 * @param {Array} anchors 全部锚点
 * @param {string} text 本轮发言
 * @param {object} [deps]
 * @param {(anchor, text) => Promise<string|null>} [deps.classify] 模型判定，可选
 * @returns {Promise<{changed: Array, pending: Array}>}
 *   changed: 已转态的锚点；pending: 规则未定、需要模型判的 [{anchor, text}]
 */
export async function processResolution(anchors, text, deps = {}) {
  const changed = [];
  const checked = [];

  for (const a of anchors) {
    if (!a || a.state !== 'open') continue;

    // 只有"在聊这件事"时才判 —— 这是成本闸门，实测约 13% 的轮次
    const scored = scoreTrigger(a, text);
    if (!isRelatedToAnchor(scored)) continue;

    checked.push(a.id);

    // 主路径：交给模型。规则在真实说法上错误率太高（实测 16 条错 5 条），
    // 只能当兜底。这里不预先跑规则，避免"规则错判导致根本没机会问模型"。
    let verdict = null;
    let source = 'none';

    if (deps.classify) {
      try {
        verdict = await deps.classify(a, text);
        source = 'model';
      } catch {
        verdict = null;   // 模型失败 → 落到规则
      }
    }

    // 降级：只在模型**完全失败**时才用规则（它多半返回 unknown，即"不动"）。
    // 模型给出了明确标签就先信模型 —— 规则在歧义句上不如它。
    if (verdict === null) {
      const ruleVerdict = ruleResolve(text);
      if (ruleVerdict !== 'unknown') {
        verdict = ruleVerdict;
        source = 'fallback-rule';
      } else {
        verdict = 'unknown';
        source = 'none';
      }
    }

    if (verdict === 'resolved') {
      a.state = 'resolved';
      a.resolvedAt = Date.now();
      a.resolutionNote = resolveNote(text);
      changed.push({ anchor: a, verdict, source });
    } else if (verdict === 'continuing') {
      // 明确延续 → 保持 open，记一次提及（说明还在聊这件事）
      a.mentions = a.mentions ?? [];
      a.mentions.push({ at: Date.now(), excerpt: summarize(text, 80) });
    }
    // unknown → 什么都不做。判不清就不动。
  }

  return { changed, checked };
}

/**
 * 执行淡出。把长期沉默且权重低的锚点标记为 faded。
 *
 * 不删除 —— faded 是可恢复的，再次提及时会被复活（见 reviveIfMentioned）。
 *
 * @returns {Array} 本次被淡出的锚点
 */
export function applyFade(anchors, now = Date.now()) {
  const faded = [];
  const day = 86400000;

  for (const a of anchors) {
    if (!a || a.state === 'faded') continue;

    const last = Math.max(
      a.lastRecalledAt ?? 0,
      a.when ?? 0,
      ...(a.mentions ?? []).map((m) => m.at ?? 0),
    );
    const idleDays = (now - last) / day;

    // 已解决的事：淡出得更快（事情过去了）
    const threshold = a.state === 'resolved' ? FADE_RESOLVED_AFTER_DAYS : FADE_AFTER_DAYS;

    if (idleDays >= threshold && (a.weight ?? 0) < FADE_WEIGHT_BELOW) {
      a.fadedFrom = a.state;   // 记住淡出前的状态，复活时恢复
      a.state = 'faded';
      a.fadedAt = now;
      faded.push(a);
    }
  }

  return faded;
}

/**
 * 复活：淡出的锚点再次被提及时，重新变为 open（若原本是 resolved 则恢复 resolved）。
 *
 * 这是"淡出 ≠ 删除"的意义：人也会忘记很久以前的事，
 * 但一旦有人提起，那些事又回来了。
 */
export function reviveIfMentioned(anchors, text, now = Date.now()) {
  const revived = [];
  for (const a of anchors) {
    if (!a || a.state !== 'faded') continue;
    const scored = scoreTrigger(a, text);
    if (!isRelatedToAnchor(scored)) continue;

    // 恢复淡出前的状态（存在 fadedFrom 里，没有就退回 open）
    a.state = a.fadedFrom ?? 'open';
    delete a.fadedFrom;
    delete a.fadedAt;
    a.revivedAt = now;
    a.mentions = a.mentions ?? [];
    a.mentions.push({ at: now, excerpt: summarize(text, 80) });
    revived.push(a);
  }
  return revived;
}

/** 标记一次回忆：更新计数与权重衰减 */
export function markRecalled(anchor, now = Date.now()) {
  anchor.recalledCount = (anchor.recalledCount ?? 0) + 1;
  anchor.lastRecalledAt = now;
  anchor.weight = round(Math.max(0.05, (anchor.weight ?? 0.5) * WEIGHT_DECAY_PER_RECALL));
  return anchor;
}

/**
 * 渲染注入段。
 *
 * 刻意把「回忆内容」与「使用指引」分开：前者随锚点变化，后者是固定文本。
 * 指引明确写了"可以说也可以不说" —— 否则模型会把回忆硬塞进对话，
 * 变成"你还记得三个月前你妈住院吗"这种尴尬。
 */
export function renderRecall(recalled) {
  if (!recalled || recalled.length === 0) return '';
  const lines = [];
  lines.push('## 你想起的事');
  lines.push('');
  for (const { anchor } of recalled) {
    const when = formatWhen(anchor.when);
    const tail = anchor.state === 'resolved' && anchor.resolutionNote
      ? `（后来 ${anchor.resolutionNote}）`
      : '';
    lines.push(`- ${when} TA 提过「${anchor.summary}」${tail}`);
  }
  lines.push('');
  lines.push(
    '这些是你自己记得的，不是查到的。合适就自然提起，不合适就放在心里。'
      + '不要生硬地复述时间地点，也不要每句都提。',
  );
  return lines.join('\n');
}

function formatWhen(ts) {
  if (!ts) return '之前';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

function round(v, d = 3) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export { ANCHOR_STATES, MAX_ANCHORS, WEIGHT_DECAY_PER_RECALL };
