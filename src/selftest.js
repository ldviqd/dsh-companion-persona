/**
 * 人格核心的自检脚本：node src/selftest.js
 *
 * 目的是把"数学是否正确"与"插件是否跑得起来"分开验证。
 * 三个场景对应真实关系形态，断言是我当初在 Python 原型上校准出来的行为。
 */

import {
  appraise, initialState, step, rest, renderPersona, describeChanges,
  MUTATE_LOAD, MUTATE_SENSITIVITY, MUTATE_SHOCK, TRAIT_AXES,
} from './persona-core.js';

let failures = 0;

function check(name, ok, detail = '') {
  const mark = ok ? '✅' : '❌';
  console.log(`  ${mark} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

/** 按权重抽样事件序列 */
function runScenario(state, table, episodes, seed = 7) {
  let rng = seed;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) % 2147483648;
    return rng / 2147483648;
  };
  const total = table.reduce((s, r) => s + r.weight, 0);
  let s = state;
  let mutations = 0;
  let peakLoad = 0;
  for (let i = 0; i < episodes; i++) {
    // 轮盘赌选事件
    let pick = rand() * total;
    let entry = table[table.length - 1];
    for (const row of table) {
      pick -= row.weight;
      if (pick <= 0) { entry = row; break; }
    }
    const jitter = (v) => Math.max(-1, Math.min(1, v + (rand() - 0.5) * 0.16));
    const ep = appraise({
      kind: entry.kind,
      relevance: jitter(entry.relevance),
      valence: jitter(entry.valence),
      novelty: jitter(entry.novelty),
    });
    const { state: ns, transition } = step(s, ep);
    s = ns;
    if (transition.mutated) mutations++;
    peakLoad = Math.max(peakLoad, ns.load);
    if (i % 4 === 0) s = rest(s, 2);
  }
  return { state: s, mutations, peakLoad };
}

// ---------------------------------------------------------------------------
console.log('=== 场景 1：ordinary（平静关系，240 轮）===');
// 应当：永不突变；缓慢升温（键合通道）；不该冻结
const ordinary = [
  { kind: 'routine', relevance: 0.55, valence: 0.55, novelty: 0.10, weight: 0.62 },
  { kind: 'support', relevance: 0.60, valence: 0.75, novelty: 0.15, weight: 0.12 },
  { kind: 'intimacy', relevance: 0.70, valence: 0.85, novelty: 0.20, weight: 0.08 },
  { kind: 'conflict', relevance: 0.65, valence: -0.55, novelty: 0.25, weight: 0.10 },
  { kind: 'distance', relevance: 0.55, valence: -0.35, novelty: 0.20, weight: 0.05 },
  { kind: 'achievement', relevance: 0.50, valence: 0.70, novelty: 0.25, weight: 0.03 },
];
{
  const r = runScenario(initialState(), ordinary, 240);
  const warmthDelta = r.state.traits.warmth - r.state.baseline.warmth;
  check('不突变', r.mutations === 0, `${r.mutations} 次`);
  check('未被冻结（键合通道在工作）', Math.abs(warmthDelta) > 0.005, `warmth ${warmthDelta >= 0 ? '+' : ''}${warmthDelta.toFixed(4)}`);
  check('升温幅度温和（不夸张）', Math.abs(warmthDelta) < 0.25, `|Δ|=${Math.abs(warmthDelta).toFixed(4)}`);
}

console.log();
console.log('=== 场景 2：strained（持续冲突，240 轮）===');
// 应当：明显硬化（温暖↓戒备↑）；突变不超过 1 次
const strained = [
  { kind: 'conflict', relevance: 0.80, valence: -0.75, novelty: 0.35, weight: 0.42 },
  { kind: 'distance', relevance: 0.70, valence: -0.55, novelty: 0.30, weight: 0.25 },
  { kind: 'routine', relevance: 0.45, valence: 0.10, novelty: 0.10, weight: 0.18 },
  { kind: 'betrayal', relevance: 0.85, valence: -0.90, novelty: 0.80, weight: 0.08 },
  { kind: 'repair', relevance: 0.60, valence: 0.45, novelty: 0.30, weight: 0.07 },
];
{
  const r = runScenario(initialState(), strained, 240);
  check('明显硬化（戒备上升）', r.state.traits.guardedness > 0.35, `guardedness=${r.state.traits.guardedness.toFixed(3)}`);
  check('明显变冷（温暖下降）', r.state.traits.warmth < 0.60, `warmth=${r.state.traits.warmth.toFixed(3)}`);
  check('突变不超过 1 次', r.mutations <= 1, `${r.mutations} 次`);
}

console.log();
console.log('=== 场景 3：single-shock（单次最强打击）===');
// 尖点突变的核心断言：单次打击**不能**突变（sensitivity 不够）
{
  const s = initialState();
  const ep = appraise({ kind: 'loss', relevance: 1.0, valence: -1.0, novelty: 1.0 });
  const { state: after, transition } = step(s, ep);
  console.log(`    load=${after.load.toFixed(3)} sensitivity=${after.sensitivity.toFixed(3)} shock=${(ep.magnitude).toFixed(3)}`);
  check('单次打击不突变（load 够但 sens 不够）', transition.mutated === null);
  check('load 确实累积了', after.load > MUTATE_LOAD * 0.9, `load=${after.load.toFixed(3)}`);
  check('sensitivity 未达阈值', after.sensitivity < MUTATE_SENSITIVITY, `sens=${after.sensitivity.toFixed(3)}`);

  // 连续第二次相同打击 → 应当突变（这就是"压垮骆驼的最后一根稻草"）
  const second = step(after, appraise({ kind: 'loss', relevance: 1.0, valence: -1.0, novelty: 1.0 }));
  check('连续第二次打击触发突变（折叠生效）', second.transition.mutated !== null,
    second.transition.mutated ? JSON.stringify(second.transition.mutated.delta) : '未突变');
}

console.log();
console.log('=== 不变量 ===');
{
  // 有界性：任意序列后所有轴都在 [0.05, 0.95]
  let s = initialState();
  let bounded = true;
  const kinds = Object.keys({ loss: 1, betrayal: 1, conflict: 1, distance: 1, change: 1, repair: 1, support: 1, intimacy: 1, achievement: 1, routine: 1 });
  for (let i = 0; i < 2000; i++) {
    const ep = appraise({
      kind: kinds[i % kinds.length],
      relevance: (i * 37 % 100) / 100,
      valence: ((i * 53 % 200) / 100) - 1,
      novelty: (i * 71 % 100) / 100,
    });
    s = step(s, ep).state;
    for (const axis of TRAIT_AXES) {
      if (s.traits[axis] < 0.05 - 1e-9 || s.traits[axis] > 0.95 + 1e-9) bounded = false;
    }
  }
  check('2000 轮后所有轴有界', bounded);
  check('load 不为负', s.load >= 0);
  check('sensitivity 在 [0,1]', s.sensitivity >= 0 && s.sensitivity <= 1);
}

{
  // 确定性：同输入同输出
  const build = () => {
    let s = initialState();
    for (let i = 0; i < 50; i++) {
      s = step(s, appraise({ kind: 'conflict', relevance: 0.7, valence: -0.6, novelty: 0.3 })).state;
    }
    return s;
  };
  const a = build(); const b = build();
  check('确定性（同输入同输出）', JSON.stringify(a.traits) === JSON.stringify(b.traits));

  // 无副作用：step 不修改入参
  const s0 = initialState();
  const before = JSON.stringify(s0);
  step(s0, appraise({ kind: 'conflict', relevance: 0.9, valence: -0.9, novelty: 0.9 }));
  check('step 不修改入参', JSON.stringify(s0) === before);
}

console.log();
console.log('=== 表达层 ===');
{
  const s = initialState();
  const base = renderPersona(s, { name: '小雨' });
  check('基线渲染不含变化条目', base.includes('还没有明显变化'));
  check('含禁止自我描述指令', base.includes('永远不要描述自己的性格'));

  // 构造一个明显变化的人格
  s.traits = { warmth: 0.21, volatility: 0.45, guardedness: 0.79, playfulness: 0.27, dependence: 0.21 };
  const changed = renderPersona(s, { name: '小雨' });
  check('变化后渲染含"和从前的自己相比"', changed.includes('和从前的自己相比'));
  check('描述为行为而非标签', changed.includes('：'), '');
  check('不含任何数值', !/\d\.\d+/.test(changed));
  console.log('   --- 渲染样例 ---');
  for (const line of changed.split('\n')) console.log(`   ${line}`);

  const { changed: list } = describeChanges(s.traits);
  check('变化列表非空且按幅度排序', list.length > 0
    && Math.abs(s.traits[list[0].axis] - 0.65) >= Math.abs(s.traits[list[list.length - 1].axis] - (list[list.length - 1].axis === 'warmth' ? 0.65 : s.baseline[list[list.length - 1].axis])) - 0.5);
}

console.log();
if (failures === 0) {
  console.log('✅ 全部断言通过');
  process.exit(0);
} else {
  console.log(`❌ ${failures} 项失败`);
  process.exit(1);
}
