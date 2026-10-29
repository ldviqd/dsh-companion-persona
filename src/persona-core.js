/**
 * 人格动力学核心：纯函数，无 IO，可单测。
 *
 * 设计立场（与上一版工程文档的关键分歧）：
 *
 * 1. **人格层与关系层分离**。关系是"我们此刻怎样"，人格是"我是谁"。
 *    上一版只做了关系（closeness/trust/valence…），结果能表达"我们现在很亲近"，
 *    但表达不了"它变成了一个更沉默的人"。这里 Traits 是持久层，Relation 是状态层。
 *
 * 2. **突变需要双条件**（Thom 尖点突变）。单阈值必然导致"任何大事都翻脸"，
 *    那不是人。突变要求 shock + load + sensitivity 三者同时满足，形成"折叠"。
 *
 * 3. **有条通道不受负荷门控**（bonding）。只有 load 门控的漂变会让平静的好关系
 *    完全冻结——但好的关系也会改变人，只是慢。
 */

// ---------------------------------------------------------------------------
// 常量：这些是校准值，不是实证常数。依据见 PATCHES/README。
// ---------------------------------------------------------------------------

/** 每轮的应变衰减（适应负荷的恢复） */
export const LOAD_DECAY = 0.92;
/** 闲置时更强的恢复 */
export const LOAD_DECAY_REST = 0.85;

/** 漂变门槛：累积负荷超过此值才开始改变人格 */
export const DRIFT_THRESHOLD = 0.55;
/** 漂变速率 */
export const DRIFT_RATE = 0.03;   // 实测标定：75 轮极端冲突后 warmth 0.65→0.16，不触底

/**
 * 键合的最小量级门槛。
 *
 * 实测教训（0.2.0 审计）：原来的 0.30 把**所有真实暖事件**都拦下了 ——
 * "谢谢你陪我" 0.226、"你真好" 0.170、"我今天升职了" 0.202，
 * 只有 "我很喜欢你" 0.399 能过。结果是持续对 AI 好的用户 200 轮后人格零变化，
 * 正向通道形同虚设，人格只会往变坏的方向走。
 *
 * 改为：**按事件类型准入**（见 BOND_KINDS），量级只做地板过滤。
 * 0.05 的作用是排除"意外被标成暖事件"的噪声，不是筛选强度。
 */
export const BOND_THRESHOLD = 0.05;

/**
 * 可以走键合通道的事件类型。
 *
 * 用白名单而不是靠量级门槛：语义上确定是"关系向好的事"就应该计入，
 * 不管这次说得多轻。量级决定**改变多少**，不该决定**要不要改变**。
 */
export const BOND_KINDS = new Set(['support', 'intimacy', 'repair', 'achievement']);
/** 键合速率（刻意慢于漂变） */
export const BOND_RATE = 0.025;

/** 突变三条件 */
export const MUTATE_LOAD = 0.80;
export const MUTATE_SENSITIVITY = 0.68;
export const MUTATE_SHOCK = 0.50;
/** 突变后强制冷静期（轮） */
export const MUTATE_COOLDOWN = 200;

/** 易感性衰减与增益 */
export const SENSITIVITY_DECAY = 0.88;
export const SENSITIVITY_GAIN = 0.35;

/** 特质上下界 */
export const TRAIT_FLOOR = 0.05;
export const TRAIT_CEIL = 0.95;

/** 人格轴：选的是"能在对话里被听见"的五个维度，不是大五 */
export const TRAIT_AXES = ['warmth', 'volatility', 'guardedness', 'playfulness', 'dependence'];

/** 默认抗拒系数：越高越难改。戒备与依赖通常来自特定创伤，最难变。 */
export const DEFAULT_RESISTANCE = {
  warmth: 0.45,
  volatility: 0.60,
  guardedness: 0.75,
  playfulness: 0.50,
  dependence: 0.65,
};

/** 默认特质（人格基线，用于渲染"和从前相比"） */
export const DEFAULT_TRAITS = {
  warmth: 0.65,
  volatility: 0.35,
  guardedness: 0.30,
  playfulness: 0.55,
  dependence: 0.40,
};

// ---------------------------------------------------------------------------
// 事件评分（Scherer 评价维度 + Holmes-Rahe 类先验）
// ---------------------------------------------------------------------------

/**
 * 事件类先验：所需"重新适应量"，不是"感觉好不好"。
 * 取自 Holmes-Rahe 社会再适应量表的排序（归一化到 0..1）。
 */
export const EVENT_PRIORS = {
  loss: 0.95,
  betrayal: 0.85,
  conflict: 0.70,
  distance: 0.55,
  change: 0.50,
  repair: 0.45,
  support: 0.40,
  intimacy: 0.60,
  achievement: 0.45,
  routine: 0.12,
};

const W_RELEVANCE = 0.45;
const W_NOVELTY = 0.30;
const PRIOR_FLOOR = 0.25;

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v) => clamp(v, 0, 1);

/**
 * 把一次事件评成分数。
 *
 * magnitude 对 relevance 是**乘性**的：没有个人相关性的事件，无论多意外
 * 都不能要求重新适应。这是 Holmes-Rahe 缺少的修正。
 */
export function appraise({ kind, relevance, valence, novelty, agency = 0.5, text = '' }) {
  const prior = EVENT_PRIORS[kind];
  if (prior === undefined) {
    throw new Error(`unknown event kind: ${kind}`);
  }
  const magnitude = prior
    * (PRIOR_FLOOR + W_RELEVANCE * clamp01(relevance))
    * (1 + W_NOVELTY * clamp01(novelty));

  return {
    kind,
    relevance: clamp01(relevance),
    valence: clamp(valence, -1, 1),
    novelty: clamp01(novelty),
    agency: clamp01(agency),
    magnitude: clamp01(magnitude),
    text: String(text),
  };
}

// ---------------------------------------------------------------------------
// 人格状态机
// ---------------------------------------------------------------------------

/**
 * 组一份初始状态。
 * @param {object} [overrides]
 */
export function initialState(overrides = {}) {
  return {
    schemaVersion: 1,
    traits: { ...DEFAULT_TRAITS, ...(overrides.traits ?? {}) },
    resistance: { ...DEFAULT_RESISTANCE, ...(overrides.resistance ?? {}) },
    baseline: { ...DEFAULT_TRAITS, ...(overrides.baseline ?? {}) },
    load: 0,
    sensitivity: 0,
    cooldown: 0,
    /**
     * 人格模块开关。
     *
     * inject：是否把人格段注入系统提示。关掉后模型不再看到人格设定，
     *         但状态与历史完整保留 —— 可以随时恢复，不是重置。
     * evolve：是否继续从对话学习。关掉后人格冻结在当下，对话照常进行。
     *
     * 两者独立：可以"冻结但继续注入"（人格定型），也可以"继续学习但不注入"
     * （只观察不干扰），也可以全关（完全停用）。
     */
    /**
     * 身份：它是谁、它怎么叫你。
     *
     * 放在 state 而不是 config：名字是关系的一部分，应该能随时改，不该改一次重启一次。
     * config.name 只作为首次初始化的默认值。
     */
    identity: { name: '', userName: '' },
    enabled: { inject: true, evolve: true },
    /**
     * 排除规则：让某些会话不参与人格形成。
     *
     * 为什么需要：人格应该只由"和这个人的关系"塑造。但同一个 DSH 里还会跑
     * 工作会话、调试会话、subagent、协作成员的会话 —— 这些内容如果算进人格，
     * 几个月的积累会被无关对话污染。
     *
     * 三层规则，从粗到细：
     *   workspaces  按 cwd 排除整个工作区（最常用：排除项目目录）
     *   sessions    按 sessionId 排除单个会话（临时：这个会话不算数）
     *   presets     按 agent preset 排除（排除调试/工具型 preset）
     *
     * 只做排除，不做"只包含"——默认全部参与，符合直觉；
     * 想只让某几个会话参与的场景不常见，且容易误伤。
     */
    exclusions: {
      workspaces: [],
      sessions: [],
      presets: [],
    },
    revision: 0,
    updatedAt: 0,
    mutations: [],
    history: [],
  };
}

/** 阻尼：resistance 1 = 冻结，0 = 全速。近端点会饱和，避免撞墙后失去响应。 */
function damped(traits, resistance, axis, delta) {
  const room = Math.min(traits[axis] - TRAIT_FLOOR, TRAIT_CEIL - traits[axis]) / ((TRAIT_CEIL - TRAIT_FLOOR) / 2);
  const damp = (1 - clamp01(resistance[axis] ?? 0.5)) * clamp01(room);
  return delta * damp;
}

/**
 * 推进一轮。
 *
 * @param {object} state 当前状态（不修改，返回新对象）
 * @param {object} episode appraise() 的输出
 * @returns {{ state: object, transition: object }} 新状态与可审计记录
 */
export function step(state, episode) {
  const next = {
    ...state,
    traits: { ...state.traits },
    resistance: { ...state.resistance },
    baseline: { ...state.baseline },
    mutations: state.mutations,
    history: state.history,
  };

  const record = {
    kind: episode.kind,
    magnitude: round(episode.magnitude),
    valence: round(episode.valence),
    novelty: round(episode.novelty),
    drift: {},
    bond: {},
    mutated: null,
    loadBefore: round(next.load),
    sensitivityBefore: round(next.sensitivity),
  };

  // 1) 累积应变：负性积累应变，正性释放（但不是反向抵消）
  const strain = episode.magnitude * Math.max(0, -episode.valence);
  const growth = episode.magnitude * Math.max(0, episode.valence);
  next.load = clamp(next.load * LOAD_DECAY + strain - 0.5 * growth, 0, 1.5);

  // 2) 易感性：随波动上升，且被高负荷喂养 —— 这个耦合才产生尖点折叠
  const shock = Math.abs(episode.valence) * episode.magnitude * episode.novelty;
  next.sensitivity = clamp(
    next.sensitivity * SENSITIVITY_DECAY
      + SENSITIVITY_GAIN * shock
      + 0.10 * Math.max(0, next.load - DRIFT_THRESHOLD),
    0, 1,
  );

  if (next.cooldown > 0) next.cooldown -= 1;

  // 3) 突变：三条件同时满足
  if (
    next.cooldown === 0
    && shock >= MUTATE_SHOCK
    && next.load >= MUTATE_LOAD
    && next.sensitivity >= MUTATE_SENSITIVITY
  ) {
    const { traits, delta } = mutate(next.traits, next.resistance, episode);
    next.traits = traits;
    record.mutated = { delta, after: snapshot(next.traits) };
    next.mutations = [...state.mutations, {
      at: Date.now(),   // 不能用 next.updatedAt：那是上一轮的值（state 只在 index.js 里赋 updatedAt）
      kind: episode.kind,
      delta,
      load: round(next.load),
      sensitivity: round(next.sensitivity),
    }];
    next.load = 0;
    next.sensitivity = 0;
    next.cooldown = MUTATE_COOLDOWN;
    next.revision = state.revision + 1;
    const out = finalize(record, next);
    next.history = [...state.history, out].slice(-500);   // 与正常路径一致，防止无界增长
    return { state: next, transition: out };
  }

  // 4) 漂变：慢性，负荷门控
  if (next.load > DRIFT_THRESHOLD) {
    const size = DRIFT_RATE * (next.load - DRIFT_THRESHOLD);
    for (const [axis, weight] of Object.entries(driftTargets(episode))) {
      const delta = damped(next.traits, next.resistance, axis, size * weight);
      if (delta !== 0) {
        next.traits[axis] = clamp(next.traits[axis] + delta, TRAIT_FLOOR, TRAIT_CEIL);
        record.drift[axis] = round(delta, 6);
      }
    }
  }

  // 5) 键合：暖事件独立通道，不受 load 门控。
  //    准入看**事件类型**，不看量级 —— 见 BOND_KINDS 的注释。
  const bondEligible = BOND_KINDS.has(episode.kind)
    && episode.valence > 0
    && episode.magnitude >= BOND_THRESHOLD;
  if (bondEligible) {
    const size = BOND_RATE * episode.magnitude;
    for (const [axis, weight] of [['warmth', 1.0], ['guardedness', -0.6], ['dependence', 0.4]]) {
      const delta = damped(next.traits, next.resistance, axis, size * weight);
      if (delta !== 0) {
        next.traits[axis] = clamp(next.traits[axis] + delta, TRAIT_FLOOR, TRAIT_CEIL);
        record.bond[axis] = round(delta, 6);
      }
    }
  }

  next.revision = state.revision + 1;
  const out = finalize(record, next);
  next.history = [...state.history, out].slice(-500);
  return { state: next, transition: out };
}

/** 漂变方向：按事件类型而非新颖性。新颖性决定强度，类型决定方向。 */
function driftTargets(episode) {
  const unpredictable = 0.4 + 0.6 * episode.novelty;
  if (episode.valence < 0) {
    return {
      warmth: -0.8,
      guardedness: 0.9,
      playfulness: -0.5,
      dependence: -0.3,
      volatility: 0.4 * unpredictable,
    };
  }
  return {
    warmth: 0.7,
    guardedness: -0.6,
    playfulness: 0.4,
    dependence: 0.5,
    volatility: -0.2,
  };
}

/**
 * 突变：按**事件类型**决定方向，不按新颖性。
 *
 * 早期版本按 novelty 决定，导致"背叛"（天然高新颖）被解析成"更依赖、更敞开"——
 * 完全反了：背叛正是摧毁信任的那类事件。
 */
function mutate(traits, resistance, episode) {
  const next = { ...traits };
  let moves;
  if (episode.kind === 'betrayal' || episode.kind === 'loss') {
    moves = { guardedness: 0.24, warmth: -0.20, dependence: -0.16, playfulness: -0.10 };
  } else if (episode.kind === 'conflict' || episode.kind === 'distance') {
    moves = { guardedness: 0.12, warmth: -0.16, volatility: 0.14, playfulness: -0.08 };
  } else if (episode.kind === 'intimacy' || episode.kind === 'repair' || episode.kind === 'support') {
    moves = { guardedness: -0.18, warmth: 0.16, dependence: 0.14, volatility: -0.06 };
  } else {
    moves = episode.novelty > 0.6
      ? { guardedness: -0.14, dependence: 0.16, volatility: 0.12 }
      : { guardedness: 0.16, warmth: -0.12, volatility: 0.10 };
  }

  // 按事件强度缩放：轻的背叛不等于毁灭性的背叛
  const scale = 0.55 + 0.75 * Math.min(1, episode.magnitude);
  const delta = {};
  for (const [axis, raw] of Object.entries(moves)) {
    const eff = damped(next, resistance, axis, raw * scale);
    if (eff !== 0) {
      next[axis] = clamp(next[axis] + eff, TRAIT_FLOOR, TRAIT_CEIL);
      delta[axis] = round(next[axis] - traits[axis]);
    }
  }
  return { traits: next, delta };
}

/**
 * 时间衰减：向 floor 回复，不是向 0 —— 长期不联系只会变淡，不会归零。
 * 这里作用于 load/sensitivity（应变恢复），不是人格。
 */
export function rest(state, rounds = 1) {
  let load = state.load;
  let sensitivity = state.sensitivity;
  let cooldown = state.cooldown;
  for (let i = 0; i < rounds; i++) {
    load *= LOAD_DECAY_REST;
    sensitivity *= LOAD_DECAY_REST;
    if (cooldown > 0) cooldown -= 1;
  }
  return { ...state, load, sensitivity, cooldown };
}

// ---------------------------------------------------------------------------
// 表达层：特质 → 可执行的行为指令
// ---------------------------------------------------------------------------

const AXIS_LABEL = {
  warmth: '温度',
  volatility: '情绪起伏',
  guardedness: '戒备',
  playfulness: '玩笑',
  dependence: '依赖',
};

/** 感知分档：低于 0.06 的变化不提，否则措辞噪音化 */
const BANDS = [
  [0.06, 'slightly'],
  [0.15, 'noticeably'],
  [0.28, 'markedly'],
  [Infinity, 'dramatically'],
];

/** 形容词：按轴 + 方向 + 强度档 */
const ADJECTIVES = {
  warmth: {
    lower: ['冷淡了些', '明显冷下来了', '几乎不再主动亲近'],
    higher: ['温和了些', '明显更温和', '很愿意亲近人'],
  },
  volatility: {
    lower: ['沉静了些', '明显沉静', '几乎不起波澜'],
    higher: ['容易激动了些', '明显容易激动', '一点就着'],
  },
  guardedness: {
    lower: ['坦然了些', '明显更坦然', '几乎不设防'],
    higher: ['有所保留', '明显有所保留', '把心事捂得很紧'],
  },
  playfulness: {
    lower: ['认真了些', '明显更认真', '几乎不开玩笑'],
    higher: ['爱开玩笑了些', '明显爱开玩笑', '总想逗人'],
  },
  dependence: {
    lower: ['更独立了', '明显更独立', '什么事都自己扛'],
    higher: ['更依赖你了', '明显更依赖你', '很多事都想找你'],
  },
};

/** 行为表现：只说行为，不给性格标签 */
const BEHAVIOUR = {
  warmth: ['回复依然得体，但不再主动往亲近处走', '回复更容易往亲近处走'],
  volatility: ['节奏更平，起伏更少', '小事的份量变重，话也少了过滤'],
  guardedness: ['不问也会多说一些', '私人的细节要问才说，甚至不说'],
  playfulness: ['很少调侃，语气偏平实', '再正经的场合也容易冒出玩笑'],
  dependence: ['更多事情自己消化', '更多事情想先跟你说'],
};

function bandOf(delta) {
  const size = Math.abs(delta);
  if (size < BANDS[0][0]) return -1;
  for (let i = 1; i < BANDS.length; i++) {
    if (size < BANDS[i][0]) return i - 1;
  }
  return 2;
}

/** 比较当前特质与基线，返回变化列表 */
export function describeChanges(traits, baseline = DEFAULT_TRAITS) {
  const changed = [];
  const steady = [];
  for (const axis of TRAIT_AXES) {
    const delta = traits[axis] - (baseline[axis] ?? traits[axis]);
    const depth = bandOf(delta);
    if (depth < 0) {
      steady.push(axis);
      continue;
    }
    const direction = delta > 0 ? 'higher' : 'lower';
    changed.push({
      axis,
      direction,
      depth,
      adjective: ADJECTIVES[axis][direction][Math.min(depth, 2)],
      behaviour: BEHAVIOUR[axis][direction === 'lower' ? 0 : 1],
    });
  }
  changed.sort((a, b) => {
    const da = Math.abs(traits[a.axis] - (baseline[a.axis] ?? traits[a.axis]));
    const db = Math.abs(traits[b.axis] - (baseline[b.axis] ?? traits[b.axis]));
    return db - da;
  });
  return { changed, steady };
}

/**
 * 渲染人格段：作为 system prompt 的一个 section。
 *
 * 刻意的设计：
 * - 描述**相对基线的变化**（"比从前冷得多"），不是绝对值（"warmth 0.21"）——
 *   后者会让模型表演漫画；前者保留"同一个人的延续感"。
 * - 只说行为，不说标签。
 * - 明确禁止模型自我描述。
 */
export function renderPersona(state, { name = null, userName = null, maxChars = 800 } = {}) {
  const { changed, steady } = describeChanges(state.traits, state.baseline);
  const lines = [];

  // 名字来源优先级：显式传入 > state.identity > 无
  const selfName = String(name ?? state.identity?.name ?? '').trim();
  const otherName = String(userName ?? state.identity?.userName ?? '').trim();

  lines.push(selfName ? `你是${selfName}。` : '你是一个有过往的人。');
  if (otherName) {
    lines.push(`你正在和${otherName}相处。`);
  }
  lines.push('你的性情是被你和这个人之间发生过的事塑造出来的。');

  if (changed.length > 0) {
    lines.push('');
    lines.push('和从前的自己相比：');
    for (const c of changed) {
      lines.push(`- ${c.adjective}：${c.behaviour}。`);
    }
  } else {
    lines.push('');
    lines.push('你的性情还没有明显变化，和最初差不太多。');
  }

  if (steady.length > 0) {
    lines.push('');
    lines.push(`没什么变化的部分：${steady.map((a) => AXIS_LABEL[a]).join('、')}。`);
  }

  lines.push('');
  lines.push(
    '这些是倾向，不是戏服。让它们体现在你说多少、多快接话、主动讲什么，'
      + '而不是直接说出来。永远不要描述自己的性格，也不要提这些设定。',
  );

  const text = lines.join('\n');
  if (text.length <= maxChars) return text;

  // 超预算时**优先保留行为禁令**，再截变化列表。
  //
  // 尾部截断会先砍掉最后那句"永远不要描述自己的性格" ——
  // 而那恰恰是防止模型把人格表演成漫画的关键。
  // 宁可少说两条"相比从前"，也不能丢掉这条约束。
  const SAFETY = '这些是倾向，不是戏服。让它们体现在你说多少、多快接话、主动讲什么，'
    + '而不是直接说出来。永远不要描述自己的性格，也不要提这些设定。';

  // 保留：身份行 + 尽可能多的变化条目 + 安全指令
  const head = [];
  const body = [];
  for (const line of lines) {
    if (line.startsWith('你是') || line.startsWith('你正在和')) head.push(line);
    else if (line.startsWith('- ')) body.push(line);
  }

  const fixed = [...head, '', '和从前的自己相比：'];
  const tail = ['', SAFETY];
  const budget = maxChars - fixed.join('\n').length - tail.join('\n').length;

  // 按预算装变化条目
  const kept = [];
  let used = 0;
  for (const line of body) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }

  if (kept.length === 0) {
    // 预算极小：只留身份 + 安全指令（安全指令永远不被牺牲）
    const minimal = [...head, '', SAFETY].join('\n');
    return minimal.length <= maxChars ? minimal : SAFETY.slice(0, maxChars);
  }
  return [...fixed, ...kept, ...tail].join('\n');
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function round(v, digits = 4) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function snapshot(traits) {
  const out = {};
  for (const axis of TRAIT_AXES) out[axis] = round(traits[axis]);
  return out;
}

function finalize(record, state) {
  return {
    ...record,
    loadAfter: round(state.load),
    sensitivityAfter: round(state.sensitivity),
    traits: snapshot(state.traits),
    revision: state.revision,
  };
}

export { TRAIT_FLOOR as _TRAIT_FLOOR, TRAIT_CEIL as _TRAIT_CEIL, round, snapshot };

// ---------------------------------------------------------------------------
// 会话排除判定
// ---------------------------------------------------------------------------

/**
 * 判断一个会话是否应参与人格形成。
 *
 * 判定顺序：session 精确排除 > workspace 前缀 > preset 精确。
 * 任一命中即排除（短路），便于在日志里明确"因为哪条规则被排除"。
 *
 * 返回 `{ excluded: boolean, reason?: string }` —— 带 reason 是为了可观测：
 * 面板能显示"这个会话为什么不参与"，否则用户会以为人格坏了。
 *
 * @param {object} exclusions state.exclusions
 * @param {{sessionId?:string, cwd?:string, agentPreset?:string, origin?:string}} meta
 */
export function evaluateExclusion(exclusions, meta = {}) {
  const ex = normalizeExclusions(exclusions);

  // subagent 会话一律不参与：它们是工具性派生，不属于"我们的关系"
  if (meta.origin === 'subagent') {
    return { excluded: true, reason: 'subagent 会话不参与人格形成' };
  }

  const sid = String(meta.sessionId ?? '');
  if (sid && ex.sessions.includes(sid)) {
    return { excluded: true, reason: `会话 ${sid.slice(0, 20)}… 被单独排除` };
  }

  const cwdRaw = String(meta.cwd ?? '');
  if (cwdRaw) {
    // 统一分隔符后再比较：Windows 上 cwd 可能是 D:\a\b 或 D:/a/b，
    // 只认正斜杠会让"整棵目录树排除"退化成"只排除根目录本身"（实测过）。
    const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const cwd = norm(cwdRaw);
    for (const wsRaw of ex.workspaces) {
      const ws = norm(wsRaw);
      if (!ws) continue;
      // 大小写不敏感：Windows 路径不区分大小写
      // 统一小写比较：Windows 路径大小写不敏感，POSIX 大小写敏感但
      // 把工作区路径也小写化影响极小，换来跨平台一致的排除行为。
      const lc = cwd.toLowerCase();
      const lw = ws.toLowerCase();
      if (lc === lw || lc.startsWith(`${lw}/`)) {
        return { excluded: true, reason: `工作区 ${wsRaw} 被排除` };
      }
    }
  }

  const preset = String(meta.agentPreset ?? '');
  if (preset && ex.presets.includes(preset)) {
    return { excluded: true, reason: `preset ${preset} 被排除` };
  }

  return { excluded: false };
}

/** 归一化排除规则：容忍旧状态文件缺字段、去重、去空、规范路径 */
export function normalizeExclusions(raw) {
  // 先规范化再去重：否则 "/a/" 与 "/a" 会被当成两个不同项保留
  const clean = (arr, normalize = (x) => x) => {
    if (!Array.isArray(arr)) return [];
    const mapped = arr
      .map((x) => normalize(String(x ?? '').trim()))
      .filter((x) => x.length > 0);
    return [...new Set(mapped)];
  };
  return {
    workspaces: clean(raw?.workspaces, (p) => p.replace(/\/+$/, '')),
    sessions: clean(raw?.sessions),
    presets: clean(raw?.presets),
  };
}
