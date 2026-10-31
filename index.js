/**
 * dsh-companion-persona：陪伴型人格插件。
 *
 * 本插件只负责人格（特质状态、漂变、突变、表达层、注入），
 * 不依赖任何外部记忆插件，也不读写它们的存储。
 *
 * 人格注入走 **system prompt 的 section**，不是伪装成用户消息 —— 这样模型把它
 * 当"我是谁"，而不是"用户说了什么"。作用域挂在 agent.ctx，只影响本 agent。
 *
 * @module dsh-companion-persona
 */

import Schema from '@deepseek-ai/schemastery';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';

import {
  appraise,
  initialState,
  step as stepPersona,
  rest as restPersona,
  renderPersona,
  snapshot,
  describeChanges,
  evaluateExclusion,
  normalizeExclusions,
  TRAIT_AXES,
} from './src/persona-core.js';
import { extractSignals, inferEventKind, calibrateValence } from './src/signals.js';
import { createJudge, toEpisode, CLASSIFIER_PROMPT } from './src/judge.js';
import {
  loadAnchors, saveAnchors, maybeCreateAnchor, selectRecall,
  markRecalled, renderRecall, processResolution, applyFade, reviveIfMentioned,
} from './src/anchor-store.js';
import { RESOLVE_PROMPT, parseResolveKind } from './src/anchor-resolve.js';
import { buildTriggers, makeAnchorId } from './src/anchor.js';
import { appendLedger } from './src/ledger.js';

export const name = 'companion-persona';
export const inject = ['systemPrompt', 'agents', 'webServer', 'workspaceRegistry', 'sessions', 'llm'];

export const Config = Schema.object({
  /** 人格名字。空则不渲染"你是X"。 */
  name: Schema.string().default('小雨'),
  /** 状态文件路径。默认 $DSH_HOME/companion/state.json */
  statePath: Schema.string().default(''),
  /** 注入段的最大字符数。超预算从"没什么变化的部分"开始砍。 */
  maxChars: Schema.number().min(200).max(4000).default(800),
  /** 段排序。默认挂在 persona 前缀之后（0 是 deployment persona）。 */
  order: Schema.number().default(10),
  /** 是否把每次变更写入 ledger（可审计的人格时间线）。 */
  audit: Schema.boolean().default(true),
  /** 干跑：只计算不注入，用于观察。 */
  dryRun: Schema.boolean().default(false),
  /** 事件判定用的 provider（留空则跟随宿主默认）。 */
  judgeProvider: Schema.string().default(''),
  /** 事件判定用的 model。 */
  judgeModel: Schema.string().default(''),
  /** 记忆锚点：从对话里抽取情感事件，命中关键词时注入"回想"。 */
  anchorEnabled: Schema.boolean().default(true),
});

const STATE_DIR_NAME = 'companion';

/** 决定状态文件位置：显式配置 > $DSH_HOME/companion/state.json */
function resolveStatePath(config, ctx) {
  if (config.statePath) return config.statePath;

  // 用宿主自己的 home 解析（@deepseek-ai/dsh-home-paths）。
  // 自己拼路径会在 Windows 上落到错误的位置，也会和 DSH 其它数据脱节。
  // 该包是纯函数集合，不是注入服务 —— 直接 import 即可。
  try {
    // 动态解析：该包在 DSH 运行时必然存在；作为独立 npm 包安装时可能缺席，
    // 那时退回环境变量也不会出错。用同步 require 走 Node 的 CJS 桥。
    const mod = globalThis.__personaHomePaths ?? null;
    const h = mod?.defaultDshHome?.();
    if (typeof h === 'string' && h.length > 0) {
      return join(h, STATE_DIR_NAME, 'state.json');
    }
  } catch { /* 包不可用 → 退回环境变量 */ }

  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, STATE_DIR_NAME, 'state.json');
}

/** 原子写：先写临时文件再 rename，避免半写状态。 */
async function atomicWriteText(file, text) {
  const dir = join(file, '..');
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

async function loadState(file) {
  const fallback = initialState();
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion === 1 && parsed.traits) {
      // 兼容旧状态文件：补齐后加的字段（开关）
      if (parsed.enabled === undefined) {
        parsed.enabled = { ...fallback.enabled };
      } else {
        parsed.enabled = {
          inject: parsed.enabled.inject !== false,
          evolve: parsed.enabled.evolve !== false,
        };
      }
      // 兼容旧状态文件：补齐排除规则
      parsed.exclusions = normalizeExclusions(parsed.exclusions);
      // 兼容旧状态：补齐身份；首次运行时用 config.name 作为初始值
      if (parsed.identity === undefined || parsed.identity === null) {
        parsed.identity = { name: '', userName: '' };
      } else {
        parsed.identity = {
          name: String(parsed.identity.name ?? ''),
          userName: String(parsed.identity.userName ?? ''),
        };
      }
      return parsed;
    }
    return fallback;
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    // 状态损坏：不阻断对话，重建
    return fallback;
  }
}

export async function apply(ctx, config) {
  // 尝试加载宿主的 home 解析包（可选依赖）。
  // 失败完全无损：resolveStatePath 会退回 DSH_HOME / ~/.dsh。
  if (!globalThis.__personaHomePaths) {
    try {
      globalThis.__personaHomePaths = await import('@deepseek-ai/dsh-home-paths');
    } catch { /* 独立安装场景，忽略 */ }
  }
  const statePath = resolveStatePath(config, ctx);
  // 锚点与人格状态分开存：锚点是 append-mostly，人格是每轮改写，
  // 混在一起会让每次人格更新都重写整个锚点库。
  const anchorPath = join(statePath, '..', 'anchors.json');
  const logger = ctx.logger?.('companion-persona');
  let state = await loadState(statePath);
  let anchors = config.anchorEnabled ? await loadAnchors(anchorPath) : [];
  // 首次运行：用配置里的名字作为初始值（之后可在面板改）
  if (!state.identity.name && config.name) {
    state = { ...state, identity: { ...state.identity, name: config.name } };
  }
  /**
   * 本轮待注入的回忆文本。
   *
   * 为什么用变量而不是在 section 的 text() 里实时计算：
   * section 每次装配都会调用 text()，而"这一轮提到了什么"是**轮次级**信息。
   * 在 turn/end 时算一次、存起来，下次装配读取 —— 语义正确，也不会重复计算。
   */
  let pendingRecallText = '';

  /**
   * 最近一次排除判定的结果。
   *
   * 面板需要它来解释"为什么人格没变化、为什么没有锚点"。
   * 没有这个字段时，用户看到空面板只会以为功能坏了 —— 实际是排除规则在生效。
   */
  let currentExclusion = null;
  /** 锚点处理轮次计数（用于控制淡出检查频率） */
  let anchorTick = 0;

  /** 解决检测的判定缓存：`anchorId + 文本前 120 字` → verdict */
  const resolveCache = new Map();

  let persistChain = Promise.resolve();

  /**
   * 状态更新的串行队列。
   *
   * 为什么必须串行：判定是异步的（要调模型）。如果两轮判定重叠，
   * 后完成的那轮会因为读的是一份过期的 state 快照而覆盖先完成的写入
   * （lost update）。实测：两轮并发后 load 只剩后一轮的结果。
   *
   * 0.1.x 是同步处理所以没这个问题 —— 这是引入 LLM 判定时带入的回归。
   */
  let stateChain = Promise.resolve();
  const withStateLock = (fn) => {
    const run = stateChain.then(fn, fn);
    // 吞掉异常，避免一次失败就让整条链断掉
    stateChain = run.catch(() => {});
    return run;
  };

  /**
   * 事件判定器。
   *
   * 走宿主 llm 服务而不是自建 HTTP 客户端：provider/模型/回退链全部由 DSH 管理，
   * 限流时宿主会自己降级，插件不需要重复实现那套。
   */
  /**
   * 各 agent 的模型路由。
   *
   * 为什么不写死配置项：默认空串会让 ctx.llm.stream({provider:'', model:''})
   * 每轮抛 NO_ADAPTER，判定永远走降级 —— 用户以为开了 LLM 判定，实际一直是规则。
   * 实测过这个"静默失效"，比报错更糟。
   *
   * 正确来源是 agent.options：那就是这个 agent 当前真正在用的 provider/model，
   * 用户换模型时自动跟随，不需要改插件配置。
   */
  const agentRoutes = new WeakMap();
  const routeByAgentId = new Map();

  /** 解析本次判定该用哪个路由：显式配置 > 当前 agent > 任意已知 agent > 让宿主默认 */
  function pickRoute(agentHint) {
    // 1) 显式配置优先（用户想固定判定通道时用）
    if (config.judgeProvider && config.judgeModel) {
      return { provider: config.judgeProvider, model: config.judgeModel };
    }
    // 2) 当前 session 所属 agent 的路由
    const sid = typeof agentHint === 'string' ? agentHint : agentHint?.sessionId;
    if (sid && routeByAgentId.has(sid)) {
      const r = routeByAgentId.get(sid);
      if (r?.provider && r?.model) return r;
    }
    // 3) 任意已知 agent（单用户部署下通常只有一个）
    for (const r of routeByAgentId.values()) {
      if (r?.provider && r?.model) return r;
    }
    return null;
  }

  const judge = createJudge({
    classify: async (text, agentHint) => {
      const route = pickRoute(agentHint);
      if (!route) {
        throw new Error('no model route available for judging');
      }
      // ctx.llm.stream() 是宿主唯一的一等调用入口，带 provider 路由与回退。
      const chunks = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system: CLASSIFIER_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        maxTokens: 16,
        temperature: 0,
      });
      let out = '';
      for await (const chunk of chunks) {
        if (chunk?.type === 'text-delta') out += chunk.text;
      }
      return out;
    },
    logger,
  });

  const persist = () => {
    // 串行化写入，避免并发覆盖
    persistChain = persistChain
      .then(() => atomicWriteText(statePath, `${JSON.stringify(state, null, 2)}\n`))
      .catch((err) => logger?.warn?.(`状态写入失败: ${String(err)}`));
    return persistChain;
  };

  /** 给一个 agent 挂 scoped section。幂等：同 agent 重复调用只会注册一次。 */
  const sectioned = new WeakSet();
  const registerSection = (agent) => {
    if (!agent?.ctx || sectioned.has(agent)) return;
    sectioned.add(agent);
    // 记录该 agent 的模型路由（判定通道跟随它）
    try {
      const opt = agent.options ?? {};
      const route = { provider: opt.provider, model: opt.model, reasoningEffort: opt.reasoningEffort };
      if (route.provider && route.model) {
        agentRoutes.set(agent, route);
        const id = agent.session?.id;
        if (typeof id === 'string') routeByAgentId.set(id, route);
      }
    } catch { /* options 不可读时忽略，走 fallback 路由 */ }
    try {
      const agentCtx = agent.ctx;
      const disposer = agentCtx.systemPrompt.section({
        name: 'companion-persona',
        order: config.order,
        // 每次装配时重算：人格可能在轮次之间变化
        text: () => {
          // 注入开关关闭 → 返回空串，section 自动消失（不影响其它系统提示）
          if (state.enabled?.inject === false) return '';
          try {
            return renderPersona(state, { maxChars: config.maxChars });
          } catch (err) {
            logger?.warn?.(`人格渲染失败，降级为空段: ${String(err)}`);
            return '';
          }
        },
      });
      // 记忆锚点段：与人格段分开。
      //
      // 人格段是**稳定身份**，每次装配都是同一段话；
      // 锚点是**此刻想起的事**，每轮都可能不同。
      // 混在一个 section 里会让"我是谁"看起来每轮都在变。
      if (config.anchorEnabled) {
        const recallDisposer = agentCtx.systemPrompt.section({
          name: 'companion-anchor-recall',
          order: config.order + 5,   // 紧跟人格段之后
          text: () => {
            if (state.enabled?.inject === false) return '';
            try {
              // 用上一轮记录的待注入锚点（在 turn/end 时算好）
              return pendingRecallText;
            } catch {
              return '';
            }
          },
        });
        if (typeof recallDisposer === 'function') {
          agentCtx.effect(() => recallDisposer, 'companion-persona.anchor()');
        }
      }

      // section() 已返回 effect disposer，直接交给 agent 作用域即可，
      // 再包一层 effect 只是多一层无意义的嵌套。
      if (typeof disposer === 'function') {
        agentCtx.effect(() => disposer, 'companion-persona.section()');
      }
    } catch (err) {
      logger?.warn?.(`人格段注册失败: ${String(err)}`);
    }
  };

  /** 每次 agent 创建时挂 section —— 只影响该 agent。 */
  ctx.on('agent/created', ({ agent }) => registerSection(agent), { prepend: true });

  /**
   * 兜底：插件加载时**已存在**的 agent 不会收到 agent/created。
   * 场景：HMR 重载插件、或插件晚装。不补这一步，当前会话永远看不到人格段。
   */
  try {
    const existing = ctx.agents?.list?.() ?? [];
    for (const agent of existing) registerSection(agent);
    if (existing.length > 0) logger?.info?.(`已为 ${existing.length} 个既有 agent 补注册人格段`);
  } catch (err) {
    logger?.warn?.(`补注册既有 agent 失败: ${String(err)}`);
  }

  /** 轮次结束：抽取信号 → 推进人格 → 落盘。 */
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;

    /**
     * 回忆是一次性的：入口就清空。
     *
     * 否则遇到"本轮被排除/冻结"的分支提前 return，pendingRecallText 不会被
     * 覆盖，下一轮装配时会再次注入上一轮的回忆 —— 过期且重复。
     * 在入口清空能保证"最多注入一次"，代价是那一轮如果被排除，回忆就丢了
     * （可以接受：被排除的对话本来就不该产生人格影响）。
     */
    pendingRecallText = '';

    // 只处理真人对话轮次（有 user 消息的）
    let userTexts;
    try {
      const messages = session.deriveMessages?.() ?? [];
      userTexts = messages
        .filter((m) => m?.role === 'user' && m?.source?.kind === 'user')
        .map((m) => contentToText(m.content))
        .filter((t) => t.length > 0);
    } catch {
      return;
    }
    if (userTexts.length === 0) return;

    const text = userTexts[userTexts.length - 1];

    // 找到这个 session 对应的 agent，让判定走它当前在用的模型
    let agentHint = null;
    try {
      agentHint = typeof session.id === 'string' ? session.id : null;
    } catch { /* 忽略 */ }

    // 排除判定：某些会话不参与人格形成（工作区 / 单会话 / preset / subagent）
    let header = {};
    try { header = session.header ?? {}; } catch { header = {}; }
    const exclusionVerdict = evaluateExclusion(state.exclusions, {
      sessionId: session.id ?? header.id,
      cwd: header.cwd,
      agentPreset: header.agentPreset,
      origin: header.origin,
    });
    currentExclusion = exclusionVerdict.excluded
      ? { excluded: true, reason: exclusionVerdict.reason }
      : { excluded: false, reason: null };

    if (exclusionVerdict.excluded) {
      if (config.audit) {
        appendLedger(join(statePath, '..', 'ledger.jsonl'), {
          at: Date.now(), kind: 'excluded', signals: {}, before: {}, after: {},
          transition: {},
          evidence: `${exclusionVerdict.reason}｜${text.slice(0, 100)}`,
        }).catch?.(() => {});
      }
      return;
    }

    // 演化开关关闭 → 人格冻结，对话照常。不积累负荷、不漂变，
    // 但仍记录一条"已冻结"的轨迹，避免面板看起来像坏了。
    if (state.enabled?.evolve === false) {
      if (config.audit) {
        appendLedger(join(statePath, '..', 'ledger.jsonl'), {
          at: Date.now(), kind: 'frozen', signals: {}, before: {}, after: {},
          transition: {}, evidence: text.slice(0, 120),
        }).catch?.(() => {});
      }
      return;
    }

    // 判定是异步的（可能调模型）。turn/end 监听器不 await，
    // 所以人格变化在下一轮生效 —— 这符合直觉，也不阻塞对话。
    // 用 withStateLock 串行化：await 前后跨共享 state 必须串行，否则丢更新。
    void withStateLock(async () => {
      const verdict = await judge.judge(text, agentHint);
      const kind = verdict.kind;
      if (!kind) return;

      // 闲置恢复：距离上次更新越久，load/sensitivity 衰减越多。
      //
      // 旧代码导入了 rest() 却从未调用 —— 后果是 load 单调饱和到 1.5、
      // sensitivity 饱和到 1.0，突变三条件退化为"只要 shock ≥ 0.5"，
      // 尖点模型的折叠保护完全消失（单次背叛即可突变）。
      const idleMinutes = (Date.now() - (state.updatedAt || Date.now())) / 60000;
      if (idleMinutes >= 30) {
        // 每 30 分钟视为一轮闲置恢复；上限 8 轮，避免长期不联系后一次归零
        const rounds = Math.min(8, Math.floor(idleMinutes / 30));
        state = restPersona(state, rounds);
      }

      const episode = toEpisode(kind, text);
      const signals = extractSignals(text);

      // ---- 记忆锚点 ----
      //
      // 顺序很关键：先用**本轮文本**召回（此时锚点库还是注入前的状态），
      // 再决定是否新建锚点。反过来会让本轮刚建出的锚点立刻自己触发自己。
      if (config.anchorEnabled) {
        try {
          // P4a：淡出的锚点若被再次提到，先复活（这样本轮就能召回它）
          const revived = reviveIfMentioned(anchors, text, Date.now());
          if (revived.length > 0) {
            logger?.info?.(`锚点复活: ${revived.map((a) => a.summary).join(', ')}`);
          }

          const recalled = selectRecall(anchors, text, Date.now());
          if (recalled.length > 0) {
            pendingRecallText = renderRecall(recalled);
            for (const r of recalled) markRecalled(r.anchor, Date.now());
            if (config.audit) {
              appendLedger(join(statePath, '..', 'ledger.jsonl'), {
                at: Date.now(), kind: 'recall', signals: {}, before: {}, after: {},
                transition: {},
                evidence: `想起：${recalled.map((r) => r.anchor.summary).join(' / ')}`,
              }).catch?.(() => {});
            }
          } else {
            pendingRecallText = '';
          }

          const created = maybeCreateAnchor(anchors, {
            kind, signals, episode, text, at: Date.now(),
          });
          if (created) {
            anchors = [...anchors, created];
            if (config.audit) {
              appendLedger(join(statePath, '..', 'ledger.jsonl'), {
                at: Date.now(), kind: 'anchor-new', signals: {}, before: {}, after: {},
                transition: {},
                evidence: `新建锚点「${created.summary}」(${created.kind}, 权重 ${created.weight})`,
              }).catch?.(() => {});
            }
          }
          // P2：判断"这件事怎么样了"。以模型为主 —— 实测规则在真实说法上
          // 16 条错 5 条（「出院手续还没办」会被判成"已解决"），只能当兜底。
          //
          // 成本闸门在 processResolution 内部：只有与 open 锚点相关时才调模型
          // （实测约 13% 的轮次）。这里再加一层缓存，避免同一句话重复判定。
          //
          // 顺序在新建锚点之后：新建的锚点本轮不该被自己的话判成 resolved。
          const resolution = await processResolution(anchors, text, {
            classify: async (anchor, txt) => {
              const cacheKey = `${anchor.id}\u0000${txt.slice(0, 120)}`;
              if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey);
              const route = pickRoute(agentHint);
              if (!route) return null;
              const chunks = ctx.llm.stream({
                provider: route.provider,
                model: route.model,
                system: RESOLVE_PROMPT.replace('{ANCHOR}', anchor.summary),
                messages: [{ role: 'user', content: [{ type: 'text', text: txt }] }],
                maxTokens: 12,
                temperature: 0,
              });
              let out = '';
              for await (const ch of chunks) {
                if (ch?.type === 'text-delta') out += ch.text;
              }
              const verdict = parseResolveKind(out);
              // 缓存上限 200：一条锚点的判定期通常只有几个说法，够用
              if (verdict && resolveCache.size < 200) resolveCache.set(cacheKey, verdict);
              return verdict;
            },
          });
          if (resolution.changed.length > 0) {
            for (const c of resolution.changed) {
              if (config.audit) {
                appendLedger(join(statePath, '..', 'ledger.jsonl'), {
                  at: Date.now(), kind: 'anchor-resolved', signals: {}, before: {}, after: {},
                  transition: {},
                  evidence: `锚点已解决「${c.anchor.summary}」：${c.anchor.resolutionNote ?? ''}(${c.source})`,
                }).catch?.(() => {});
              }
            }
          }

          // P4b：定期执行淡出（每 20 轮检查一次，不必每轮扫）
          anchorTick++;
          if (anchorTick % 20 === 0) {
            const faded = applyFade(anchors, Date.now());
            if (faded.length > 0) {
              logger?.info?.(`锚点淡出: ${faded.map((a) => a.summary).join(', ')}`);
            }
          }

          // 异步落盘，不阻塞人格更新
          void saveAnchors(anchorPath, anchors).catch((err) => {
            logger?.warn?.(`锚点保存失败: ${String(err?.message ?? err)}`);
          });
        } catch (err) {
          logger?.warn?.(`锚点处理失败: ${String(err?.message ?? err)}`);
        }
      }

      const before = { traits: snapshot(state.traits), load: state.load, sensitivity: state.sensitivity };
      const { state: next, transition } = stepPersona(state, episode);
      state = { ...next, updatedAt: Date.now() };

    // 没有实际变化就不落盘（省 IO）
    const traitsMoved = JSON.stringify(before.traits) !== JSON.stringify(snapshot(state.traits));
    const loadMoved = Math.abs(before.load - state.load) > 1e-6;
    const sensMoved = Math.abs(before.sensitivity - state.sensitivity) > 1e-6;
    if (!traitsMoved && !loadMoved && !sensMoved) return;

    if (config.audit) {
      appendLedger(join(statePath, '..', 'ledger.jsonl'), {
        at: Date.now(),
        kind,
        signals: {
          relevance: round(signals.relevance), valence: round(signals.valence),
          novelty: round(signals.novelty),
        },
        before,
        after: { traits: snapshot(state.traits), load: round(state.load), sensitivity: round(state.sensitivity) },
        transition: { drift: transition.drift, bond: transition.bond, mutated: transition.mutated },
        // 证据：原始用户发言（截断，避免把全文灌进审计）
        evidence: text.slice(0, 200),
        source: verdict.source,
      }).catch?.(() => {});
    }

    void persist();
    })().catch((err) => logger?.warn?.(`人格更新失败: ${String(err?.message ?? err)}`));
  });

  // ---------------------------------------------------------------------------
  // 面板数据通道：POST /persona/rpc/<method>
  //
  // 用 webServer 前缀路由而不是 connection.rpc：client 侧按 document.baseURI 解析，
  // 反向代理前缀（如 /app/<name>）自动带上；connection.rpc 需要通道两边严格对齐，
  // 部署前缀变化时容易 404。
  // ---------------------------------------------------------------------------
  const RPC_PREFIX = '/persona/rpc';
  /**
   * 请求闸门。
   *
   * 两条必须同时成立：
   *   1. Host 是 loopback 或本机 trusted host（防 DNS rebinding）
   *   2. 若带 Origin，必须与 Host 同源（防 CSRF：恶意页面跨站 POST 时
   *      浏览器会带上自己的 Origin，与目标 Host 不符）
   *
   * 早期版本 `host === ''` 直接放行，等于空 Host 绕过全部检查 ——
   * 我们自己接管了鉴权，就不能留这种口子。
   */
  const hostsAllowed = () => {
    const list = ['127.0.0.1', 'localhost', '[::1]', '::1'];
    try {
      const startup = ctx.get?.('webRuntime') ?? ctx.get?.('webStartup');
      const extra = startup?.trustedHosts;
      if (Array.isArray(extra)) {
        for (const h of extra) {
          const bare = String(h).replace(/:\d+$/, '').toLowerCase();
          if (bare) list.push(bare);
        }
      }
    } catch { /* 读不到就用默认 */ }
    return list;
  };
  const HOST_FENCE = (req) => {
    const rawHost = String(req.headers?.host ?? '').trim();
    if (rawHost === '') return false;   // 空 Host 一律拒绝
    const bareHost = rawHost.replace(/:\d+$/, '').toLowerCase();
    const allowed = hostsAllowed().map((h) => h.toLowerCase());
    if (!allowed.includes(bareHost)) return false;

    // CSRF：浏览器跨站请求会带 Origin
    const origin = req.headers?.origin;
    if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
      try {
        const o = new URL(origin);
        if (o.host.toLowerCase() !== rawHost.toLowerCase()) return false;
      } catch {
        return false;   // Origin 无法解析 → 拒绝
      }
    }
    return true;
  };
  const sendJson = (res, status, body) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });

  const handlers = {
    async state() {
      const changed = describeChangesForPanel(state);
      return {
        ok: true,
        value: {
          identity: state.identity,
          traits: snapshot(state.traits),
          baseline: state.baseline,
          load: state.load,
          sensitivity: state.sensitivity,
          cooldown: state.cooldown,
          // v0.3：突变新增两个条件，面板要能看到它们，否则用户不知道
          // "为什么吵了这么多次还不突变"
          trustDamage: state.trustDamage ?? 0,
          negativeSinceMutation: state.negativeSinceMutation ?? 0,
          // 记忆锚点（面板展示）
          // 当前上下文的排除状态：面板要能解释"为什么没有锚点/没有变化"
          exclusion: currentExclusion,
          anchorEnabled: config.anchorEnabled,
          anchors: config.anchorEnabled
            ? anchors.map((a) => ({
                id: a.id,
                summary: a.summary,
                kind: a.kind,
                state: a.state,
                weight: a.weight,
                when: a.when,
                resolvedAt: a.resolvedAt,
                resolutionNote: a.resolutionNote,
                recalledCount: a.recalledCount ?? 0,
                lastRecalledAt: a.lastRecalledAt,
                mentionCount: (a.mentions ?? []).length,
              }))
            : [],
          revision: state.revision,
          turns: state.history.length,   // 面板展示用
          mutations: state.mutations.length,
          updatedAt: state.updatedAt,
          changed,
          enabled: { ...state.enabled },
          exclusions: normalizeExclusions(state.exclusions),
          // 候选列表：供面板下拉框直接选择，免去手输路径/ID
          candidates: collectCandidates(ctx, logger),
          // 开关影响渲染结果，关闭时如实反映
          rendered: state.enabled?.inject === false
            ? null
            : renderPersona(state, { maxChars: config.maxChars }),
        },
      };
    },
    /**
     * 切换人格模块开关。可只传一个键，未传的保持不变。
     *
     * 刻意不做"重置"：关掉只是停止行为，状态与历史保留，可随时恢复。
     * 重置人格应该是另一个明确的动作，不该混在开关里。
     */
    async toggle(payload) {
      const next = { ...state.enabled };
      let touched = false;
      for (const key of ['inject', 'evolve']) {
        const v = payload?.[key];
        if (typeof v === 'boolean' && next[key] !== v) {
          next[key] = v;
          touched = true;
        }
      }
      if (!touched) return { ok: true, value: { enabled: next, changed: false } };

      state = { ...state, enabled: next, updatedAt: Date.now() };
      await persist();

      if (config.audit) {
        appendLedger(join(statePath, '..', 'ledger.jsonl'), {
          at: Date.now(),
          kind: 'toggle',
          signals: {},
          before: {},
          after: {},
          transition: {},
          evidence: `开关 → inject=${next.inject} evolve=${next.evolve}`,
        }).catch?.(() => {});
      }

      logger?.info?.(`人格开关变更: inject=${next.inject} evolve=${next.evolve}`);
      return { ok: true, value: { enabled: next, changed: true } };
    },
    /**
     * 管理排除规则。可分别对 workspaces / sessions / presets 增删。
     *
     * 语义是"设置完整列表"而不是"增量改一项"——避免并发下两边各改一项互相覆盖。
     * 前端一次提交整个列表，简单且可预测。
     */
    async exclusions(payload) {
      const before = normalizeExclusions(state.exclusions);
      const next = { ...before };
      let touched = false;
      for (const key of ['workspaces', 'sessions', 'presets']) {
        if (payload?.[key] !== undefined) {
          const cleaned = normalizeExclusions({ [key]: payload[key] })[key];
          if (JSON.stringify(cleaned) !== JSON.stringify(before[key])) {
            next[key] = cleaned;
            touched = true;
          }
        }
      }
      if (!touched) return { ok: true, value: { exclusions: before, changed: false } };

      state = { ...state, exclusions: next, updatedAt: Date.now() };
      await persist();

      if (config.audit) {
        appendLedger(join(statePath, '..', 'ledger.jsonl'), {
          at: Date.now(), kind: 'exclusions', signals: {}, before: {}, after: {},
          transition: {},
          evidence: `排除规则 → 工作区${next.workspaces.length} 会话${next.sessions.length} preset${next.presets.length}`,
        }).catch?.(() => {});
      }
      logger?.info?.(`排除规则更新: workspaces=${next.workspaces.length} sessions=${next.sessions.length} presets=${next.presets.length}`);
      return { ok: true, value: { exclusions: next, changed: true } };
    },
    /**
     * 修改身份：它叫什么、它怎么称呼你。
     *
     * 名字是关系的一部分，不是部署配置——所以能在面板里随时改，不需要重启。
     * 空字符串是合法值（表示"暂时不起名"），渲染时会退回"你是一个有过往的人"。
     */
    async identity(payload) {
      const before = { ...state.identity };
      const next = { ...before };
      let touched = false;

      if (payload?.name !== undefined) {
        const v = String(payload.name).trim().slice(0, 40);
        if (v !== before.name) { next.name = v; touched = true; }
      }
      if (payload?.userName !== undefined) {
        const v = String(payload.userName).trim().slice(0, 40);
        if (v !== before.userName) { next.userName = v; touched = true; }
      }
      if (!touched) return { ok: true, value: { identity: before, changed: false } };

      state = { ...state, identity: next, updatedAt: Date.now() };
      await persist();

      if (config.audit) {
        appendLedger(join(statePath, '..', 'ledger.jsonl'), {
          at: Date.now(), kind: 'identity', signals: {}, before: {}, after: {},
          transition: {},
          evidence: `身份 → 自称「${next.name || '(未起名)'}」 称你「${next.userName || '(未设置)'}」`,
        }).catch?.(() => {});
      }
      logger?.info?.(`身份更新: name=${next.name || '(空)'} userName=${next.userName || '(空)'}`);
      return { ok: true, value: { identity: next, changed: true } };
    },
    /**
     * 锚点操作：标记已解决 / 淡出 / 删除。
     *
     * 只做这三个动作，不开放任意字段编辑 —— 锚点是自动抽取的，
     * 让用户手改内容会破坏 triggers 与 summary 的一致性。
     */
    async anchor(payload) {
      if (!config.anchorEnabled) {
        return { ok: false, error: { message: '锚点功能未启用' } };
      }

      // 手动添加：用户说"记住这件事"。不经过自动判据 —— 这是给用户的控制权。
      if (String(payload?.action ?? '') === 'create') {
        const summary = String(payload?.summary ?? '').trim().slice(0, 60);
        if (!summary) return { ok: false, error: { message: 'summary 不能为空' } };
        const kind = String(payload?.kind ?? 'intimacy');
        const created = {
          id: makeAnchorId(Date.now()),
          summary,
          when: Date.now(),
          kind,
          weight: Math.max(0.3, Math.min(1, Number(payload?.weight) || 0.6)),
          valence: -0.3,
          state: 'open',
          resolvedAt: null,
          resolutionNote: null,
          triggers: buildTriggers(kind, summary),
          mentions: [{ at: Date.now(), excerpt: summary }],
          recalledCount: 0,
          lastRecalledAt: null,
          manual: true,        // 标记来源：面板手动添加
        };
        anchors = [...anchors, created];
        await saveAnchors(anchorPath, anchors);
        if (config.audit) {
          appendLedger(join(statePath, '..', 'ledger.jsonl'), {
            at: Date.now(), kind: 'anchor-new', signals: {}, before: {}, after: {},
            transition: {}, evidence: `手动添加锚点「${summary}」`,
          }).catch?.(() => {});
        }
        return { ok: true, value: { anchors, note: `已记住「${summary}」` } };
      }

      const id = String(payload?.id ?? '');
      const action = String(payload?.action ?? '');
      const target = anchors.find((a) => a.id === id);
      if (!target) return { ok: false, error: { message: `未找到锚点 ${id}` } };

      let note = '';
      if (action === 'resolve') {
        target.state = 'resolved';
        target.resolvedAt = Date.now();
        target.resolutionNote = String(payload?.note ?? '').trim() || null;
        note = `标记已解决「${target.summary}」`;
      } else if (action === 'reopen') {
        // 误标已解决时能改回来
        target.state = 'open';
        target.resolvedAt = null;
        target.resolutionNote = null;
        note = `重新打开「${target.summary}」`;
      } else if (action === 'fade') {
        target.fadedFrom = target.state;   // 记住原状态，便于复活
        target.state = 'faded';
        target.fadedAt = Date.now();
        note = `淡出「${target.summary}」`;
      } else if (action === 'revive') {
        target.state = target.fadedFrom ?? 'open';
        delete target.fadedFrom;
        delete target.fadedAt;
        target.revivedAt = Date.now();
        note = `复活「${target.summary}」`;
      } else if (action === 'delete') {
        anchors = anchors.filter((a) => a.id !== id);
        note = `删除锚点「${target.summary}」`;
      } else {
        return { ok: false, error: { message: `未知操作 ${action}` } };
      }

      await saveAnchors(anchorPath, anchors);
      if (config.audit) {
        appendLedger(join(statePath, '..', 'ledger.jsonl'), {
          at: Date.now(), kind: 'anchor-edit', signals: {}, before: {}, after: {},
          transition: {}, evidence: note,
        }).catch?.(() => {});
      }
      return { ok: true, value: { anchors, note } };
    },
    async ledger(payload) {
      const limit = Math.max(1, Math.min(500, Number(payload?.limit) || 20));
      const file = join(statePath, '..', 'ledger.jsonl');
      try {
        const raw = await readFile(file, 'utf8');
        const lines = raw.split('\n').filter((l) => l.trim().length > 0);
        const entries = lines.slice(-limit).reverse().map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
        return { ok: true, value: { entries, total: lines.length } };
      } catch (err) {
        if (err?.code === 'ENOENT') return { ok: true, value: { entries: [], total: 0 } };
        return { ok: false, error: { message: String(err?.message ?? err) } };
      }
    },
  };

  try {
    const disposer = ctx.webServer.register({
      kind: 'prefix',
      path: RPC_PREFIX,
      async handler(req, res) {
        if (!HOST_FENCE(req)) return sendJson(res, 403, { ok: false, error: { message: 'forbidden' } });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { message: 'POST only' } });
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
        const method = pathname.slice(RPC_PREFIX.length + 1);
        const fn = handlers[method];
        if (typeof fn !== 'function') {
          return sendJson(res, 404, { ok: false, error: { message: `unknown method "${method}"` } });
        }
        try {
          const payload = await readBody(req);
          const result = await fn(payload);
          return sendJson(res, result.ok ? 200 : 400, result);
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: { message: String(err?.message ?? err) } });
        }
      },
    });
    ctx.effect(() => disposer, 'companion-persona.rpc()');
    logger?.info?.(`面板数据通道已注册：POST ${RPC_PREFIX}/<state|ledger>`);
  } catch (err) {
    logger?.warn?.(`面板数据通道注册失败: ${String(err)}`);
  }
}

/**
 * 收集面板下拉框的候选：当前 DSH 实例里的工作区与会话。
 *
 * 为什么要从实例里取而不是让用户手输：
 *   - 工作区路径是多层嵌套的绝对路径，手输极易错一个字符就完全不生效；
 *   - sessionId 是 uuid，用户根本记不住。
 *
 * 失败时返回空数组而非抛错——候选列表只影响便利性，不该让整个面板打不开。
 */
function collectCandidates(ctx, logger) {
  const out = { workspaces: [], sessions: [] };

  try {
    const list = ctx.workspaceRegistry?.list?.() ?? [];
    out.workspaces = list.map((w) => ({
      path: String(w.path ?? ''),
      title: String(w.title ?? w.path ?? ''),
      createdAt: w.createdAt,
    })).filter((w) => w.path.length > 0);
  } catch (err) {
    logger?.warn?.(`工作区候选读取失败: ${String(err)}`);
  }

  try {
    const sessions = ctx.sessions?.list?.() ?? [];
    out.sessions = sessions.map((sess) => {
      let header = {};
      try { header = sess.header ?? {}; } catch { header = {}; }
      return {
        id: String(sess.id ?? header.id ?? ''),
        cwd: String(header.cwd ?? ''),
        createdAt: header.createdAt,
        agentPreset: header.agentPreset ?? null,
        isSubagent: header.origin === 'subagent',
      };
    }).filter((s) => s.id.length > 0)
      // 最近的排前面，常用的容易找到
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 100);
  } catch (err) {
    logger?.warn?.(`会话候选读取失败: ${String(err)}`);
  }

  return out;
}

/** 给面板用的变化摘要（结构化，便于前端渲染） */
function describeChangesForPanel(state) {
  // 复用表达层的形容词表，保证面板措辞与注入给模型的一致
  const { changed } = describeChanges(state.traits, state.baseline);
  return changed.map((c) => ({
    axis: c.axis,
    direction: c.direction,
    depth: c.depth,
    adjective: c.adjective,
    delta: Math.round((state.traits[c.axis] - state.baseline[c.axis]) * 1000) / 1000,
  }));
}

/** 从 Block[] 提取纯文本 */
function contentToText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out.trim();
}

function round(v) { return Math.round(v * 10000) / 10000; }
