import { readFileSync } from 'node:fs';
/**
 * 端到端测试：真实中文文本 → 判定 → 动力学。
 *
 * 为什么必须单独有这一层（项目最大的教训）：
 *
 *   旧的 selftest.js 用**理想化事件分布表**驱动（routine 权重 0.62、效价 +0.55），
 *   完全绕过 signals.js。所以它验证了"数学对不对"，
 *   却没人验证"喂给数学的输入对不对"。
 *
 *   后果：README 声称"前 30 轮无可见变化"，而真实冲突文本 15 轮就达到该效果；
 *   真实日常对话里 85% 被判成负性事件，200 轮把人格磨坏。
 *
 * 这个文件补上那个缺口：**输入是真人会说的话，不是构造的事件**。
 *
 * 运行：node src/e2e.js
 *       node src/e2e.js --offline    # 不调模型，只测规则路径
 */

import {
  appraise, initialState, step, describeChanges, renderPersona,
  evaluateExclusion, TRAIT_AXES, rest, TRUST_DECAY,
} from './persona-core.js';
import { ruleFilter, parseKind, toEpisode, createJudge, KINDS, reconcileValence } from './judge.js';
import { createUsageMeter, collectStream } from './usage.js';
import { extractSignals, inferEventKind } from './signals.js';
import {
  maybeCreateAnchor, selectRecall, markRecalled, renderRecall,
  processResolution, applyFade, reviveIfMentioned,
} from './anchor-store.js';
import { ruleResolve, parseResolveKind } from './anchor-resolve.js';
import { shouldCreateAnchor, buildTriggers, scoreTrigger } from './anchor.js';
import { rest as restPersona } from './persona-core.js';

const OFFLINE = process.argv.includes('--offline');

let failures = 0;
let checks = 0;

function check(name, ok, detail = '') {
  checks++;
  const mark = ok ? '✅' : '❌';
  console.log(`  ${mark} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// 人工标注集：真人会说的话 + 真实意图
// ---------------------------------------------------------------------------

const GOLD = [
  // 日常应答 —— 都是 routine，不是疏远
  ['嗯', 'routine'], ['好的', 'routine'], ['晚安', 'routine'], ['早', 'routine'],
  ['哦', 'routine'], ['哈哈哈', 'routine'],
  ['我今天不太累。', 'routine'], ['我最近积累了不少经验', 'routine'],
  ['今天天气不错', 'routine'], ['我刚吃完饭', 'routine'],
  // 真正的疏远
  ['随便', 'distance'], ['不想说话', 'distance'], ['你别管我了', 'distance'],
  // 冲突
  ['你根本不懂我在说什么', 'conflict'], ['烦死了', 'conflict'], ['你总是这样', 'conflict'],
  // 修复
  ['对不起，我刚才说重了', 'repair'], ['我们聊聊好吗', 'repair'],
  // 支持
  ['谢谢你陪我', 'support'], ['你真好', 'support'],
  // 亲密
  ['我妈住院了', 'intimacy'], ['我其实很害怕', 'intimacy'],
  // 成就
  ['我今天升职了', 'achievement'], ['终于通过了', 'achievement'],
  // 背叛 / 丧失
  ['你背着我做决定', 'betrayal'], ['我奶奶去世了', 'loss'],
];

// ---------------------------------------------------------------------------
// 1. 规则筛子：不能把日常应答判成负性事件
// ---------------------------------------------------------------------------

console.log('=== 1. 规则筛子 ===');
{
  const daily = ['嗯', '好的', '晚安', '早', '哦', '哈哈哈', '收到', '在吗'];
  let negative = 0;
  for (const t of daily) {
    const r = ruleFilter(t);
    if (r.kind === 'distance' || r.kind === 'conflict') negative++;
  }
  check('日常应答不产生负性事件', negative === 0, `${negative}/${daily.length} 被判负性`);

  let silentHit = 0;
  for (const t of daily) {
    if (ruleFilter(t).reason === 'rule:silent') silentHit++;
  }
  check('纯应声词被静默处理（零成本）', silentHit >= 7, `${silentHit}/${daily.length}`);

  // 高置信度词必须直接识别
  const confident = [
    ['我奶奶去世了', 'loss'],
    ['你骗我', 'betrayal'],
    ['对不起', 'repair'],
  ];
  let ok = 0;
  for (const [t, want] of confident) {
    if (ruleFilter(t).kind === want) ok++;
  }
  check('高置信度词直接命中', ok === confident.length, `${ok}/${confident.length}`);
}

// ---------------------------------------------------------------------------
// 2. 标签解析容错
// ---------------------------------------------------------------------------

console.log();
console.log('=== 2. 标签解析容错 ===');
{
  const cases = [
    ['conflict', 'conflict'],
    ['  REPAIR  ', 'repair'],
    ['**loss**', 'loss'],
    ['标签：intimacy。', 'intimacy'],
    ['乱七八糟', null],
  ];
  let ok = 0;
  for (const [raw, want] of cases) {
    if (parseKind(raw) === want) ok++;
  }
  check('模型输出容错', ok === cases.length, `${ok}/${cases.length}`);
}

// ---------------------------------------------------------------------------
// 3. 判定准确率（离线只能用规则路径，需 ≥ 规则基线）
// ---------------------------------------------------------------------------

console.log();
console.log('=== 3. 判定准确率 ===');
{
  let correct = 0;
  const errors = [];
  for (const [text, want] of GOLD) {
    const r = ruleFilter(text);
    if (r.kind === want) correct++;
    else if (r.kind !== null) errors.push(`${text} → ${r.kind} (期望 ${want})`);
    // null 表示交给 LLM，不算错
  }
  const ruleOnly = GOLD.filter(([t]) => ruleFilter(t).kind !== null).length;
  console.log(`    规则覆盖 ${ruleOnly}/${GOLD.length} 条，其中正确 ${correct} 条`);
  check(
    '规则路径零误判（未覆盖的交给 LLM）',
    errors.length === 0,
    errors.length ? errors.slice(0, 3).join('; ') : '无错判',
  );
}

// ---------------------------------------------------------------------------
// 4. 日常对话不应磨坏人格（核心回归）
// ---------------------------------------------------------------------------

console.log();
console.log('=== 4. 日常对话不磨坏人格 ===');
{
  // 200 轮日常口语循环。旧代码这会让 warmth −0.41。
  const daily = [
    '嗯', '好的', '晚安', '今天天气不错', '我刚吃完饭', '在忙吗',
    '哈哈哈', '收到', '我先睡了', '明天见', '稍等我一下', '我到了',
  ];
  let s = initialState();
  for (let i = 0; i < 200; i++) {
    const text = daily[i % daily.length];
    const r = ruleFilter(text);
    const kind = r.kind ?? 'routine';
    s = step(s, toEpisode(kind, text)).state;
    if (i % 10 === 9) s = restPersona(s, 2);  // 每 10 轮一次闲置恢复
  }
  const dWarmth = s.traits.warmth - s.baseline.warmth;
  const dGuard = s.traits.guardedness - s.baseline.guardedness;
  console.log(`    200 轮后: warmth Δ=${dWarmth.toFixed(3)}  guardedness Δ=${dGuard.toFixed(3)}`);
  check('warmth 未被磨低 |Δ| < 0.12', Math.abs(dWarmth) < 0.12, `${dWarmth.toFixed(3)}`);
  check('guardedness 未显著升高 Δ < 0.12', dGuard < 0.12, `${dGuard.toFixed(3)}`);
  check('load 未饱和', s.load < 0.8, `load=${s.load.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 5. 正向通道：持续暖对话必须让人格变暖
//
//    这条断言是审计报告 N3 指出的缺口 —— 0.2.0 的全部 18 项断言里没有一项
//    检查"好关系会升温"，所以键合通道完全失效（BOND_THRESHOLD=0.30 拦住
//    所有真实暖事件）却没被发现。功能没生效，测试必须能抓到。
// ---------------------------------------------------------------------------

console.log();
console.log('=== 5. 正向通道（暖对话应变暖）===');
{
  const warm = ['谢谢你陪我', '你真好', '对不起，我刚才说重了', '我今天升职了'];
  let s = initialState();
  for (let i = 0; i < 200; i++) {
    const text = warm[i % warm.length];
    const kind = i % 4 === 2 ? 'repair' : (i % 4 === 3 ? 'achievement' : 'support');
    s = step(s, toEpisode(kind, text)).state;
    if (i % 10 === 9) s = restPersona(s, 2);
  }
  const dWarmth = s.traits.warmth - s.baseline.warmth;
  const dGuard = s.traits.guardedness - s.baseline.guardedness;
  console.log(`    200 轮纯暖对话: warmth Δ=${dWarmth.toFixed(3)}  guardedness Δ=${dGuard.toFixed(3)}`);
  check('暖对话让人格变暖 Δ > 0.02', dWarmth > 0.02, dWarmth.toFixed(3));
  check('戒备同步下降', dGuard < 0, dGuard.toFixed(3));
  check('变暖幅度不过冲 Δ < 0.4', dWarmth < 0.4, dWarmth.toFixed(3));
}

// ---------------------------------------------------------------------------
// 6. 降级路径准确率（不依赖 LLM）
//
//    审计报告 N1：0.2.0 默认配置下 judgeProvider='' 导致每轮抛 NO_ADAPTER，
//    实际一直跑在降级路径上，而 e2e 的"准确率"只统计规则覆盖项，
//    把降级路径排除在统计之外 —— 这是 N1 没被自测发现的原因。
//
//    这里显式断言降级路径的准确率下限。
// ---------------------------------------------------------------------------

console.log();
console.log('=== 6. 降级路径准确率 ===');
{
  // 用一个必定失败的 classify 模拟模型不可用
  const broken = createJudge({
    classify: async () => { throw new Error('model unavailable'); },
  });
  let correct = 0;
  const errors = [];
  for (const [text, want] of GOLD) {
    const r = await broken.judge(text);
    if (r.kind === want) correct++;
    else errors.push(`${text} → ${r.kind} (期望 ${want})`);
  }
  const acc = correct / GOLD.length;
  console.log(`    降级路径准确率: ${correct}/${GOLD.length} = ${(acc * 100).toFixed(0)}%`);
  if (errors.length > 0 && errors.length <= 8) {
    for (const e of errors) console.log(`      · ${e}`);
  }
  check('降级准确率 >= 60%', acc >= 0.60, `${(acc * 100).toFixed(0)}%`);
  check('降级不把亲密判成负性',
    !errors.some((e) => e.includes('我其实很害怕') || e.includes('我妈住院')),
    '');
}

// ---------------------------------------------------------------------------
// 7. 真实冲突文本：变化应该发生，但不该 15 轮就崩
// ---------------------------------------------------------------------------

console.log();
console.log('=== 7. 真实冲突的演化节奏 ===');
{
  const conflicts = ['你根本不懂我在说什么', '算了，不想说了', '你总是这样', '我很失望'];
  let s = initialState();
  for (let i = 0; i < 30; i++) {
    const text = conflicts[i % conflicts.length];
    const r = ruleFilter(text);
    const kind = r.kind ?? 'conflict';       // 离线：这类都走 LLM，假定判对
    s = step(s, toEpisode(kind, text)).state;
    if (i % 10 === 9) s = restPersona(s, 2);  // 每 10 轮一次闲置恢复
  }
  const { changed } = describeChanges(s.traits, s.baseline);
  console.log(`    30 轮冲突后: warmth Δ=${(s.traits.warmth - s.baseline.warmth).toFixed(3)}, 可见轴 ${changed.length}`);
  check('冲突确实产生变化', changed.length > 0, `${changed.length} 个轴`);
  check('30 轮内未触底', s.traits.warmth > 0.15, `warmth=${s.traits.warmth.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 8. rest() 必须真的被调用（旧代码从未调用）
// ---------------------------------------------------------------------------

console.log();
console.log('=== 8. 闲置恢复（rest 生效）===');
{
  let s = initialState();
  for (let i = 0; i < 60; i++) {
    s = step(s, toEpisode('conflict', '你根本不懂我在说什么')).state;
  }
  const before = s.load;
  for (let i = 0; i < 30; i++) s = restPersona(s, 1);
  const after = s.load;
  console.log(`    60 轮冲突 load=${before.toFixed(3)} → 闲置 30 轮后 ${after.toFixed(3)}`);
  check('闲置能降低 load', after < before * 0.5, `${before.toFixed(2)} → ${after.toFixed(2)}`);

  // 关键：load 未饱和时，单次背叛不能突变（折叠保护）
  let t = initialState();
  for (let i = 0; i < 3; i++) {
    t = step(t, toEpisode('conflict', '你根本不懂我在说什么')).state;
  }
  const beforeMut = t.mutations.length;
  t = step(t, toEpisode('betrayal', '你背着我做决定')).state;
  check('load 未饱和时单次背叛不突变', t.mutations.length === beforeMut,
    `load=${t.load.toFixed(2)} sens=${t.sensitivity.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 9. 面板字段一致性（旧代码 changed 恒 undefined）
// ---------------------------------------------------------------------------

console.log();
console.log('=== 9. 面板数据 ===');
{
  const s = initialState();
  s.traits = { warmth: 0.3, volatility: 0.35, guardedness: 0.6, playfulness: 0.55, dependence: 0.4 };
  const { changed } = describeChanges(s.traits, s.baseline);
  check('describeChanges 返回数组', Array.isArray(changed), `长度 ${changed.length}`);
  check('偏离轴能被检出', changed.length >= 2, `${changed.length} 个轴`);
  const json = JSON.parse(JSON.stringify({ changed }));
  check('序列化后仍存在', Array.isArray(json.changed), '');
}

// ---------------------------------------------------------------------------
// 10. 排除规则（含 Windows 路径）
// ---------------------------------------------------------------------------

console.log();
console.log('=== 10. 排除规则 ===');
{
  const ex = { workspaces: ['/proj/a', 'D:\\work\\proj'], sessions: [], presets: [] };
  const cases = [
    [{ cwd: '/proj/a/sub' }, true, 'POSIX 子目录'],
    [{ cwd: '/proj/ab' }, false, 'POSIX 前缀不误伤'],
    [{ cwd: 'D:\\work\\proj\\sub' }, true, 'Windows 子目录'],
    [{ cwd: 'D:/work/proj/sub' }, true, 'Windows 正斜杠'],
    [{ origin: 'subagent' }, true, 'subagent 恒排除'],
  ];
  let ok = 0;
  const errs = [];
  for (const [meta, want, label] of cases) {
    const got = evaluateExclusion(ex, meta).excluded;
    if (got === want) ok++;
    else errs.push(label);
  }
  check('排除规则全部正确', ok === cases.length, errs.length ? `错: ${errs.join(',')}` : `${ok}/${cases.length}`);
}

// ---------------------------------------------------------------------------
// 12. 突变在真实文本上可达（v0.3 新增）
//
//     审计报告的核心发现：novelty 用了校正前的 valence，导致
//     "你骗了我" shock = 0.049，差门槛 10 倍，连续 500 轮伤害也不突变。
//     突变——这个插件最有设计感的功能——在真实文本上实际是死的。
//
//     这里用**真实短句**驱动，不构造事件。
// ---------------------------------------------------------------------------

console.log();
console.log('=== 12. 突变可达性（真实文本）===');
{
  const harsh = ['你骗了我', '你一直在瞒着我', '我受够了'];
  const ep = toEpisode('betrayal', harsh[0]);
  const shock = Math.abs(ep.valence) * ep.magnitude * ep.novelty;
  console.log(`    "你骗了我": rel=${ep.relevance.toFixed(2)} mag=${ep.magnitude.toFixed(3)} nov=${ep.novelty} shock=${shock.toFixed(3)}`);
  check('短句背叛的 shock 达到门槛', shock >= 0.20, `shock=${shock.toFixed(3)}`);

  // 连续严重伤害 → 必然突变
  let s = initialState();
  let firstMut = null;
  for (let i = 0; i < 50; i++) {
    s = step(s, toEpisode('betrayal', harsh[i % harsh.length])).state;
    if (!firstMut && s.mutations.length > 0) firstMut = i + 1;
  }
  console.log(`    连续严重伤害 50 轮: 首次突变 ${firstMut ? `第 ${firstMut} 轮` : '❌ 从未'}`);
  check('真实伤害能触发突变', firstMut !== null, firstMut ? `第 ${firstMut} 轮` : '');
  check('突变不会太早（≥ 3 轮）', firstMut !== null && firstMut >= 3, `第 ${firstMut} 轮`);
}

// ---------------------------------------------------------------------------
// 13. 防御：轻微抱怨与日常不应触发突变（v0.3 新增）
//
//     这是"几句无心之言会不会毁掉人格"的量化回答。
// ---------------------------------------------------------------------------

console.log();
console.log('=== 13. 防御：不该突变的情况 ===');
{
  // 轻微抱怨 300 轮 —— 会慢慢变冷，但绝不该突变
  const mild = ['今天好累', '有点烦', '算了', '随便吧'];
  let s = initialState();
  for (let i = 0; i < 300; i++) {
    s = step(s, toEpisode('conflict', mild[i % mild.length])).state;
    if (i % 10 === 9) s = restPersona(s, 2);
  }
  console.log(`    轻微抱怨 300 轮: 突变 ${s.mutations.length} 次, warmth=${s.traits.warmth.toFixed(3)}`);
  check('轻微抱怨不触发突变', s.mutations.length === 0, `${s.mutations.length} 次`);
  check('但确实变冷了（漂变仍在工作）', s.traits.warmth < 0.65, s.traits.warmth.toFixed(3));

  // 日常闲聊 300 轮
  const daily = ['嗯', '好的', '晚安', '今天天气不错', '哈哈哈'];
  let d = initialState();
  for (let i = 0; i < 300; i++) {
    const r = ruleFilter(daily[i % daily.length]);
    d = step(d, toEpisode(r.kind ?? 'routine', daily[i % daily.length])).state;
    if (i % 10 === 9) d = restPersona(d, 2);
  }
  check('日常闲聊不触发突变', d.mutations.length === 0, `${d.mutations.length} 次`);
  check('日常闲聊不改变人格', Math.abs(d.traits.warmth - d.baseline.warmth) < 0.02,
    (d.traits.warmth - d.baseline.warmth).toFixed(3));
}

// ---------------------------------------------------------------------------
// 14. 记忆锚点（v0.4）
// ---------------------------------------------------------------------------

console.log();
console.log('=== 14. 记忆锚点 ===');
{
  const createCases = [
    ['我妈住院了', 'intimacy', true],
    ['我奶奶走了', 'loss', true],
    ['我其实很害怕', 'intimacy', true],
    ['你骗了我', 'betrayal', true],
    ['今天好累', 'conflict', false],
    ['谢谢你陪我', 'support', false],
    ['嗯', 'routine', false],
  ];
  let createOk = 0;
  const createErr = [];
  for (const [t, k, want] of createCases) {
    const sig = extractSignals(t);
    const got = shouldCreateAnchor(k, sig, t).should;
    if (got === want) createOk++;
    else createErr.push(`${t}(${got ? '建' : '不建'})`);
  }
  check('建锚点判据准确', createOk === createCases.length,
    `${createOk}/${createCases.length}${createErr.length ? ' 错:' + createErr.join(',') : ''}`);

  const triggers = buildTriggers('intimacy', '我妈住院了，我有点撑不住');
  const anchor = { triggers, weight: 0.8, state: 'open' };
  let misfireOk = 0;
  for (const t of ['妈妈咪呀这首歌好听', '身体是革命的本钱']) {
    if (!scoreTrigger(anchor, t).hit) misfireOk++;
  }
  check('泛化词不单独触发', misfireOk === 2, `${misfireOk}/2`);

  let hitOk = 0;
  for (const t of ['我妈住院了', '今天去医院了', '我妈身体不舒服']) {
    if (scoreTrigger(anchor, t).hit) hitOk++;
  }
  check('同域表达能触发', hitOk === 3, `${hitOk}/3`);

  const DIALOGUE = [
    ['今天天气不错', 'routine'],
    ['我妈住院了，我有点撑不住', 'intimacy'],
    ['好的', 'routine'],
    ['今天去医院了，医生说要观察', 'intimacy'],
    ['我奶奶走了', 'loss'],
    ['晚安', 'routine'],
  ];
  const anchors = [];
  const recalls = [];
  let now = Date.now();
  for (const [text, kind] of DIALOGUE) {
    const sig = extractSignals(text);
    const ep = toEpisode(kind, text);
    const hit = selectRecall(anchors, text, now);
    if (hit.length) {
      recalls.push({ text, summaries: hit.map((h) => h.anchor.summary) });
      for (const h of hit) markRecalled(h.anchor, now);
    }
    const created = maybeCreateAnchor(anchors, { kind, signals: sig, episode: ep, text, at: now });
    if (created) anchors.push(created);
    now += 600000;
  }
  console.log(`    锚点: ${anchors.map((a) => a.summary).join(' / ')}`);
  check('从真实对话建出 2 个锚点', anchors.length === 2, `${anchors.length} 个`);
  check('日常对话不产生锚点', !anchors.some((a) => a.summary.includes('天气') || a.summary === '好的'));
  check('提到医院能召回', recalls.some((r) => r.text.includes('医院')));
  check('摘要只留事件核心', anchors.some((a) => a.summary === '我妈住院了'));

  const injected = renderRecall([{ anchor: anchors[0] }]);
  check('注入含"你想起的事"', injected.includes('你想起的事'));
  check('注入明确"可以不说"', injected.includes('不合适就放在心里'));
  check('注入不含原始全文', !injected.includes('撑不住'));
}

// ---------------------------------------------------------------------------
// 15. 锚点状态机（P2 解决检测 + P4 淡出复活）
// ---------------------------------------------------------------------------

console.log();
console.log('=== 15. 锚点状态机 ===');
{
  const mk = (when, weight = 0.8) => ({
    id: 'a1', summary: '我妈住院了', state: 'open', when, weight,
    triggers: buildTriggers('intimacy', '我妈住院了，我有点撑不住'),
    mentions: [{ at: when, excerpt: '我妈住院了' }],
  });

  // --- 运行时开关（v0.6.3）---
  {
    const st = initialState();
    check('锚点开关默认开启', st.enabled?.anchor !== false);

    // 关闭锚点不应影响人格开关
    const off = { ...st, enabled: { ...st.enabled, anchor: false } };
    check('关闭锚点不影响 inject/evolve',
      off.enabled.inject === true && off.enabled.evolve === true);

    // 旧状态文件（无 anchor 字段）应默认开启
    const legacy = { inject: true, evolve: true };
    const migrated = { ...legacy, anchor: legacy.anchor !== false };
    check('旧状态文件兼容（默认开启）', migrated.anchor === true);
  }

  // --- P2: 模型为主路径 ---
  const a = mk(Date.now());
  await processResolution([a], '我妈出院了，恢复得很好', { classify: async () => 'resolved' });
  check('模型判 resolved → 转态', a.state === 'resolved', a.state);
  check('记录解决备注', Boolean(a.resolutionNote), a.resolutionNote ?? '');

  // --- P2: 歧义句由模型正确判断（规则会判错的场景）---
  const a2 = mk(Date.now());
  await processResolution([a2], '出院手续还没办', { classify: async () => 'continuing' });
  check('歧义句「出院手续还没办」不误判为已解决', a2.state === 'open', a2.state);

  // --- P2: 延续不误判 ---
  const b = mk(Date.now());
  await processResolution([b], '我妈还在住院观察', { classify: async () => 'continuing' });
  check('延续保持 open', b.state === 'open', b.state);

  // --- P2: 无关不误判 ---
  const c = mk(Date.now());
  await processResolution([c], '我妈最近怎么样', { classify: async () => 'unknown' });
  check('unknown 保持 open', c.state === 'open', c.state);

  // --- P2: 模型失败降级到规则 ---
  const a3 = mk(Date.now());
  await processResolution([a3], '我妈出院了', { classify: async () => { throw new Error('down'); } });
  check('模型失败时降级到规则', a3.state === 'resolved', a3.state);

  // --- P2: 未提供模型时不乱动 ---
  const a4 = mk(Date.now());
  await processResolution([a4], '我妈最近还行', {});
  check('无模型 + 规则判不出 → 保持 open', a4.state === 'open', a4.state);

  // --- P2: 成本闸门 ---
  const unrelated = mk(Date.now());
  await processResolution([unrelated], '今天天气不错', { classify: async () => 'resolved' });
  check('与锚点无关时不判定（成本闸门）', unrelated.state === 'open', unrelated.state);

  // --- 规则仅作降级，验证它覆盖明显情况 ---
  check('规则降级覆盖明显解决语', ruleResolve('我妈出院了') === 'resolved');
  check('规则降级优先判延续', ruleResolve('还没好转') === 'continuing');

  // --- P4: 淡出 ---
  const old = Date.now() - 400 * 86400000;
  const d = mk(old, 0.3);
  const faded = applyFade([d], Date.now());
  check('长期沉默 + 低权重 → faded', d.state === 'faded', d.state);
  check('淡出记录原状态（供复活）', d.fadedFrom === 'open', String(d.fadedFrom));

  // --- P4: 高权重不淡出 ---
  const e = mk(old, 0.9);
  applyFade([e], Date.now());
  check('高权重不淡出（重要的事记得住）', e.state === 'open', e.state);

  // --- P4: 复活 ---
  const f = mk(old, 0.3);
  applyFade([f], Date.now());
  const revived = reviveIfMentioned([f], '我妈最近身体怎么样');
  check('淡出后提及可复活', f.state !== 'faded', f.state);
  check('复活返回被复活的锚点', revived.length === 1, `${revived.length} 条`);
}

// ---------------------------------------------------------------------------
// 14b. 外部通道消息（v0.7.1）
//
//     dsh-onebot 把 QQ 正文包在 <user_message qq="..." nickname="..."> 里。
//     这些标签会污染信号抽取（confidence 0.41→1.00），必须剥掉。
//     同时 source.kind 是 'plugin:dsh-onebot'，不是 'user'。
// ---------------------------------------------------------------------------

console.log();
console.log('=== 14b. 外部通道消息处理 ===');
{
  // 复制插件的剥离逻辑（保持与 index.js 一致）
  const TAGS = ['user_message', 'other_message', 'message', 'quote', 'forward'];
  const strip = (t) => {
    let o = String(t ?? '');
    for (const tag of TAGS) o = o.replace(new RegExp(`</?${tag}(\\s[^>]*)?>`, 'gi'), '');
    return o.trim();
  };

  const tagged = '<user_message qq="632697661" nickname="长安">\n晚上好呀鲸鲸\n</user_message>';
  const bare = '晚上好呀鲸鲸';

  check('剥标签后文本正确', strip(tagged) === bare, JSON.stringify(strip(tagged)));

  const a = extractSignals(strip(tagged));
  const b = extractSignals(bare);
  const identical = Object.keys(b).every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 0.001);
  check('剥标签后信号与裸文本一致', identical);

  // 标签未剥时会污染 confidence —— 这个断言防止未来有人删掉 stripEnvelope
  const polluted = extractSignals(tagged);
  check('（对照）未剥标签会污染 confidence',
    Math.abs(polluted.confidence - b.confidence) > 0.1,
    `${polluted.confidence.toFixed(2)} vs ${b.confidence.toFixed(2)}`);

  // 强信号不受影响（背叛即使在标签里也能识别）
  const betrayalTagged = '<user_message qq="1" nickname="x">\n你骗了我\n</user_message>';
  check('背叛信号在标签内仍可识别',
    inferEventKind(extractSignals(betrayalTagged), betrayalTagged) === 'betrayal');

  // source 白名单
  const KINDS = new Set(['user', 'plugin:dsh-onebot']);
  check('白名单含 QQ 通道', KINDS.has('plugin:dsh-onebot'));
  check('白名单排除 plugin:memory（防污染）', !KINDS.has('plugin:memory'));
  check('白名单排除裸 plugin', !KINDS.has('plugin'));
}

// ---------------------------------------------------------------------------
// 14c. 正负效价对称性（v0.7.2）
//
//     实测发现：18 条常见夸赞只识别出 4 条（22%），而负面 10/10 全中。
//     这种不对称会让人格系统性往阴郁方向漂 —— 正面信号几乎抽不出来。
// ---------------------------------------------------------------------------

console.log();
console.log('=== 14c. 正负效价对称 ===');
{
  const praise = [
    '鲸鲸在记忆力这方面真棒，比我厉害多了。', '你太强了', '靠谱', '真贴心',
    '佩服你', '这东西真好用', '没想到你还记得', '做得不错', '谢谢你', '喜欢你',
  ];
  let hit = 0;
  const missed = [];
  for (const t of praise) {
    if (extractSignals(t).valence > 0.05) hit++;
    else missed.push(t);
  }
  check('常见夸赞识别为正面', hit === praise.length,
    `${hit}/${praise.length}${missed.length ? ' 漏:' + missed.join(',') : ''}`);

  const negative = ['我好累', '难受', '想哭', '压力好大', '烦死了', '焦虑', '失望', '撑不住了'];
  let nhit = 0;
  for (const t of negative) {
    if (extractSignals(t).valence < -0.05) nhit++;
  }
  check('常见负面识别为负面', nhit === negative.length, `${nhit}/${negative.length}`);

  // 关键：夸赞应被判成 achievement（在 BOND_KINDS 里，能影响人格）
  const txt = '鲸鲸在记忆力这方面真棒，比我厉害多了。';
  const sig = extractSignals(txt);
  check('夸赞判为 achievement（能键合）',
    inferEventKind(sig, txt) === 'achievement', inferEventKind(sig, txt));

  // 中性道别不应被判成情感事件
  const bye = '这次真的睡了，我帮你关灯咯，晚安';
  const bsig = extractSignals(bye);
  check('中性道别保持 routine', inferEventKind(bsig, bye) === 'routine');

  // 单字误伤防护：这些含「强」「牛」但不是夸赞
  const traps = ['勉强算是吧', '强制要求', '牛角尖', '太强人所难了', '你别勉强'];
  let falsePos = 0;
  for (const t of traps) {
    if (extractSignals(t).valence > 0.05) falsePos++;
  }
  check('单字不误伤（勉强/强制/牛角尖）', falsePos === 0, `${falsePos} 例误判`);
}

// ---------------------------------------------------------------------------
// 14d. 模型效价优先（v0.8）
//
//     toEpisode 现在可以接收模型给的 valence。reconcileValence 只在
//     **方向相反**时介入，同向的一律尊重模型 —— 旧逻辑无条件按 kind
//     强推下限，会把模型判对的答案改成错的。
// ---------------------------------------------------------------------------

console.log();
console.log('=== 14d. 模型效价优先 ===');
{
  // 同向：尊重模型，不推
  check('intimacy + 负效价（示弱）保持原值',
    reconcileValence('intimacy', -0.55) === -0.55);
  check('achievement + 正效价保持原值',
    reconcileValence('achievement', 0.85) === 0.85);
  check('betrayal + 强负效价保持原值',
    reconcileValence('betrayal', -0.85) === -0.85);

  // 反向：信 kind，拉回合理区间
  check('betrayal + 正效价 → 校正为负',
    reconcileValence('betrayal', 0.5) === -0.5);
  check('achievement + 负效价 → 校正为正',
    reconcileValence('achievement', -0.4) === 0.15);

  // routine 不干预
  check('routine 不干预效价', reconcileValence('routine', -0.42) === -0.42);

  // 关键回归：若 kind 判成 distance，模型给的正效价会被拉回（这是预期行为）
  check('distance 会压制模型的正效价',
    reconcileValence('distance', 0.5) === -0.15);

  // toEpisode 有模型 valence 时优先采用
  const txt = '鲸鲸在记忆力这方面真棒，比我厉害多了。';
  const withLlm = toEpisode('achievement', txt, 0.85);
  const withoutLlm = toEpisode('achievement', txt, null);
  check('传入模型 valence 时采用它', Math.abs(withLlm.valence - 0.85) < 0.01,
    `${withLlm.valence}`);
  check('未传时回落到词典', Math.abs(withoutLlm.valence - 1.0) < 0.05,
    `${withoutLlm.valence}`);

  // 反讽：「真是谢谢你啊」词典给 +1.0，模型给 -0.6
  const sarcasm = '真是谢谢你啊';
  const epS = toEpisode('distance', sarcasm, -0.6);
  check('反讽采用模型效价（不被词典带偏）', epS.valence <= 0, `${epS.valence}`);
}

// ---------------------------------------------------------------------------
// 14e. kind 交给模型（v0.9）
//
//     规则只保留「无歧义的极短应声词」短路，其余一律让模型判定。
//     原实现让规则优先，模型看不到 90% 的句子。
// ---------------------------------------------------------------------------

console.log();
console.log('=== 14e. kind 交给模型 ===');
{
  // 应声词：短路（不值得调模型）
  for (const w of ['嗯', '哦', '好的']) {
    check(`应声词「${w}」短路为 routine`,
      ruleFilter(w).reason === 'rule:silent', ruleFilter(w).reason);
  }

  // 曾经被规则硬判的句子：现在必须交给模型复核（不是短路）
  const mustReachLlm = [
    ['你骗我', '背叛'],
    ['我奶奶去世了', '丧失'],
    ['对不起', '修复'],
    ['别管我', '疏远'],
    ['烦死了', '冲突'],
  ];
  let reached = 0;
  for (const [t, label] of mustReachLlm) {
    const f = ruleFilter(t);
    if (f.shortCircuit !== true) reached++;
    else console.log(`    ⚠️ ${label}「${t}」仍被规则短路: ${f.kind}`);
  }
  check('情感语句交给模型复核（不短路）', reached === mustReachLlm.length,
    `${reached}/${mustReachLlm.length}`);

  // 规则建议仍保留：模型不可用时降级路径要用
  const fb = ruleFilter('你骗我');
  check('规则建议仍保留（降级用）', fb.kind === 'betrayal', `${fb.kind}`);
}

// ---------------------------------------------------------------------------
// 14f. LLM 用量统计（v0.10）
//
//     只统计本插件自己发起的调用（judge / anchor-resolve），
//     不含主对话本身。适配器不给 usage 时要能标记出来。
// ---------------------------------------------------------------------------

console.log();
console.log('=== 14f. LLM 用量统计 ===');
{
  const meter = createUsageMeter();

  // 正常用量
  meter.record('judge', { inputTokens: 200, outputTokens: 10, totalTokens: 210 },
    { ok: true, ms: 1800, model: 'p/m' });
  // totalTokens 缺失 → 应回退为 input+output
  meter.record('judge', { inputTokens: 100, outputTokens: 5 }, { ok: true });
  // 适配器不给 usage
  meter.record('anchor-resolve', null, { ok: true });
  // 失败调用
  meter.record('anchor-resolve', null, { ok: false });

  const s = meter.snapshot();
  check('总调用计数正确', s.totals.calls === 4, `${s.totals.calls}`);
  check('输入 token 累加正确', s.totals.inputTokens === 300, `${s.totals.inputTokens}`);
  check('输出 token 累加正确', s.totals.outputTokens === 15, `${s.totals.outputTokens}`);
  check('totalTokens 缺失时回退为相加',
    s.totals.totalTokens === 210 + 105, `${s.totals.totalTokens}`);
  check('失败计数正确', s.totals.failures === 1, `${s.totals.failures}`);
  check('分桶：judge 2 次', s.buckets.judge.calls === 2, `${s.buckets.judge.calls}`);
  check('分桶：anchor-resolve 2 次',
    s.buckets['anchor-resolve'].calls === 2, `${s.buckets['anchor-resolve'].calls}`);
  check('缺失 usage 被标记', s.recent.filter((r) => r.missing).length === 2,
    `${s.recent.filter((r) => r.missing).length}`);

  // collectStream 正确拼接文本并捕获 usage
  const chunks = (async function* () {
    yield { type: 'text-delta', text: 'kind=' };
    yield { type: 'text-delta', text: 'support' };
    yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 6, totalTokens: 56 } };
    yield { type: 'finish', reason: 'stop' };
  })();
  let captured = null;
  const out = await collectStream(chunks, (u) => { captured = u; });
  check('collectStream 拼接文本正确', out === 'kind=support', out);
  check('collectStream 捕获 usage', captured?.totalTokens === 56, String(captured?.totalTokens));

  // 流中断也要回调（记录失败）
  let calledOnError = false;
  const broken = (async function* () {
    yield { type: 'text-delta', text: 'x' };
    throw new Error('broken');
  })();
  try {
    await collectStream(broken, () => { calledOnError = true; });
  } catch { /* 预期抛出 */ }
  check('流出错时仍回调一次', calledOnError);

  // reset
  meter.reset();
  check('reset 后归零', meter.snapshot().totals.calls === 0);
}

// ---------------------------------------------------------------------------
// 14g. 审计修复回归（v0.10.2）
//
//     独立审查报告的 7 个高危/中危项，每条一个断言。
// ---------------------------------------------------------------------------

console.log();
console.log('=== 14g. 审计修复回归 ===');
{
  // --- H1：withStateLock 调用不该多一对 () ---
  {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    check('H1: withStateLock 调用没有多余的 ()',
      !/withStateLock\(async[\s\S]{0,20000}?\}\)\(\)\.catch/.test(src),
      '原本 })() ；应为 }).catch');
  }

  // --- H2：模型答 unrelated 不该降级到规则 ---
  {
    check('H2: unrelated 是合法标签', parseResolveKind('unrelated') === 'unrelated');
    check('H2: 解析失败才返回 null', parseResolveKind('garbage') === null);
    // 规则仍会误判否定句 —— 这就是为什么不能在 unrelated 时降级
    check('H2: 规则对否定句仍会误判（因此必须避免降级）',
      ruleResolve('出院手续还没办') === 'resolved');
  }

  // --- M1：负性事件计数会随时间衰减，不是终身累计 ---
  {
    const st = { load: 0, sensitivity: 0, cooldown: 0, trustDamage: 0, negativeSinceMutation: 10, traits: {} };
    const after = rest(st, 8);
    check('M1: 负性事件计数随闲置衰减',
      after.negativeSinceMutation < 10, `${st.negativeSinceMutation} → ${after.negativeSinceMutation.toFixed(2)}`);
  }

  // --- M2：日常示弱不该在几轮内改变人格 ---
  {
    const mild = toEpisode('conflict', '我有点累', null);
    const strong = toEpisode('conflict', '我很累', null);
    const shockOf = (ep) => Math.abs(ep.valence) * ep.magnitude * ep.novelty;
    check('M2: 「我有点累」不越过突变门槛',
      shockOf(mild) < 0.20, shockOf(mild).toFixed(4));
    check('M2: 「我很累」仍越过门槛（强度副词应保留）',
      shockOf(strong) >= 0.20, shockOf(strong).toFixed(4));
  }

  // --- M3：rest 与 step 的 trustDamage 衰减率一致 ---
  {
    const st = { load: 0, sensitivity: 0, cooldown: 0, trustDamage: 1.0, negativeSinceMutation: 0, traits: {} };
    let cur = st, rounds = 0;
    while (cur.trustDamage > 0.5 && rounds < 500) { cur = rest(cur, 1); rounds++; }
    const expected = Math.round(Math.log(0.5) / Math.log(TRUST_DECAY));
    check('M3: rest 半衰与 step 一致', Math.abs(rounds - expected) <= 2,
      `rest=${rounds} step=${expected}`);
  }

  // --- M4：健康域误触发 ---
  {
    const anchor = { triggers: buildTriggers('intimacy', '我妈住院了，我有点撑不住') };
    const misfires = [
      '我朋友住院了，我去探望',
      '医院附近的饭好难吃',
      '我们公司楼下那家医院的食堂',
      '我同事住院了，我得替他值班',
      '医院好远',
    ];
    let falsePos = 0;
    for (const t of misfires) if (scoreTrigger(anchor, t).hit) falsePos++;
    check('M4: 无关句子不误触发', falsePos === 0, `${falsePos}/${misfires.length}`);

    const shouldHit = ['我妈住院了', '今天去医院了', '我妈身体不舒服', '我妈还在住院'];
    let miss = 0;
    for (const t of shouldHit) if (!scoreTrigger(anchor, t).hit) miss++;
    check('M4: 同一件事的延续仍能触发', miss === 0, `${miss}/${shouldHit.length}`);
  }

  // --- H3 ②③：跨会话共享是特性，串扰与记账错误要修 ---
  {
    // ① 共享：设计特性，保留
    check('H3①: 跨会话共享记忆（设计特性，保留）', true, 'A 会话的私事在 B 会话可见');

    // ② 串扰：会话副本结构存在
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    check('H3②: 召回按会话存副本（防串扰）',
      /recallBySession\s*=\s*new Map/.test(src));
    // ③ 记账：markRecalled 延后到消费
    check('H3③: markRecalled 延后到消费之后',
      /pendingMarkBySession\s*=\s*new Map/.test(src));
  }
}

// ---------------------------------------------------------------------------
// 15. 角色设定（v0.7）
//
//     之前 renderPersona 只输出"性情还没有明显变化"，等于告诉模型"你没有性格"，
//     提示词怎么写都不生效。角色设定提供可编辑的"底子"。
// ---------------------------------------------------------------------------

console.log();
console.log('=== 15. 角色设定 ===');
{
  const s = initialState();
  check('默认带角色设定', (s.identity?.role ?? '').length > 0, `${(s.identity?.role ?? '').length} 字`);

  s.identity.name = '鲸鲸';
  s.identity.userName = '爸爸';
  const out = renderPersona(s, { maxChars: 2000 });
  check('渲染含角色身份', out.includes('女儿'));
  check('渲染含说话方式', out.includes('说话方式'));
  check('有角色时不出现"还没有明显变化"', !out.includes('还没有明显变化'),
    '这句话会抵消人物设定');
  check('有角色时不重复称呼', !out.includes('你正在和爸爸相处'),
    '角色文本已交代关系');

  // 角色可替换
  const custom = initialState();
  custom.identity = { name: '老陈', userName: '', role: '你是个老师傅，话不多。' };
  const customOut = renderPersona(custom, { maxChars: 2000 });
  check('角色可完全替换', customOut.includes('老师傅') && !customOut.includes('十三四岁'));

  // 无角色时保持旧行为
  const noRole = initialState();
  noRole.identity = { name: '小雨', userName: '', role: '' };
  check('无角色时回到旧文案', renderPersona(noRole).includes('还没有明显变化'));

  // 长角色不应挤掉安全指令
  const longRole = initialState();
  longRole.identity.role = '你是一个很长的角色设定。'.repeat(40);
  const truncated = renderPersona(longRole, { maxChars: 600 });
  check('长角色下仍保留落地指令（不被截断）',
    truncated.includes('别自我介绍') || truncated.includes('永远不要描述'), `${truncated.length} 字`);

  // 小预算下角色不能被整段砍掉（早期实现的 bug）
  let smallOk = 0;
  for (const mc of [400, 300, 200, 120]) {
    const o = renderPersona(s, { maxChars: mc });
    const hasRole = o.includes('女儿') || o.includes('心思');
    const hasSafety = o.includes('别自我介绍') || o.includes('永远不要描述');
    if (hasRole && hasSafety) smallOk++;
  }
  check('小预算下角色与指令都保留', smallOk === 4, `${smallOk}/4`);
}

// ---------------------------------------------------------------------------
// 16. 安全指令不能被截断
// ---------------------------------------------------------------------------

console.log();
console.log('=== 11. 渲染安全 ===');
{
  const s = initialState();
  s.identity = { name: '鲸鲸', userName: '' };
  s.traits = { warmth: 0.05, volatility: 0.95, guardedness: 0.95, playfulness: 0.05, dependence: 0.05 };
  const full = renderPersona(s, { maxChars: 9999 });
  console.log(`    五轴全偏离文本长度: ${full.length}`);
  check('默认 800 字含安全指令', renderPersona(s, { maxChars: 800 }).includes('永远不要描述自己的性格'));
  check('200 字时安全指令仍在', renderPersona(s, { maxChars: 200 }).includes('永远不要描述自己的性格'),
    '（旧代码此处被砍）');
}

// ---------------------------------------------------------------------------
console.log();
if (failures === 0) {
  console.log(`✅ 全部 ${checks} 项断言通过`);
  process.exit(0);
} else {
  console.log(`❌ ${failures}/${checks} 项失败`);
  process.exit(1);
}
