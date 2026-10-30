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

const MAX_ANCHORS = 200;
/** 注入冷却：同一锚点这段时间内不重复注入 */
export const RECALL_COOLDOWN_MS = 60 * 60 * 1000;
/** 一次最多注入几条，多了就变成数据库倾倒 */
export const MAX_INJECT = 3;
/** 每次被回忆后权重轻微下降，避免同一件事反复被想起 */
const WEIGHT_DECAY_PER_RECALL = 0.98;

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
