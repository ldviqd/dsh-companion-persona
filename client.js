/**
 * 人格面板（client bundle）。
 *
 * 格式必须与 DSH 的 ModuleLoader 契约一致：`window.__ModuleLoader__.load({id, factory})`，
 * 内部用 `require(name)` 取得宿主共享模块（react / react/jsx-runtime / slots）。
 * 共享模块来自 platform 的静态 seed 表；package.json 里的 `dsh.client.inject`
 * 管的是 **bundle 加载顺序**（依赖哪些客户端插件先就绪），不是模块来源。
 * 不能写成 ESM——浏览器加载的是这个 UMD 包装后的 factory。
 *
 * 数据通道：host 侧的 `persona/rpc/<method>` 前缀路由。
 * **必须用 document.baseURI 解析**，否则经过反向代理前缀（如 /app/<name>）访问时
 * 绝对路径会丢掉前缀 → 404。
 */
window.__ModuleLoader__.load({
  id: 'dsh-companion-persona',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    // ---------------------------------------------------------------------
    // 数据通道
    // ---------------------------------------------------------------------

    /** 端点路径（相对 baseURI 解析，兼容门户前缀） */
    function rpcUrl(method) {
      const base = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : '/';
      return new URL(`persona/rpc/${method}`, base).href;
    }

    async function callRpc(method, payload = {}) {
      let res;
      try {
        res = await fetch(rpcUrl(method), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        throw new Error(`transport failure for ${method}: ${err?.message ?? String(err)}`);
      }
      if (!res.ok) throw new Error(`transport failure for ${method}: HTTP ${res.status}`);
      return await res.json();
    }

    // ---------------------------------------------------------------------
    // 展示组件
    // ---------------------------------------------------------------------

    const C = {
      wrap: { padding: '4px 0 12px', color: 'var(--dsh-text, #333)', fontSize: 13 },
      h: { fontSize: 13, fontWeight: 600, margin: '14px 0 8px' },
      sub: { fontSize: 11, opacity: 0.6, marginBottom: 10, lineHeight: '17px' },
      row: { display: 'flex', alignItems: 'center', gap: 10, margin: '7px 0' },
      name: { width: 72, flexShrink: 0, fontSize: 12 },
      track: { flex: '1 1 auto', height: 6, borderRadius: 3, background: 'rgba(127,127,127,0.18)', position: 'relative' },
      fill: (v) => ({
        position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3,
        width: `${Math.round(v * 100)}%`,
        background: v > 0.66 ? '#2ea043' : v > 0.33 ? '#d29922' : '#8b949e',
        transition: 'width .3s',
      }),
      // 基线刻度：让人一眼看出"离最初有多远"
      mark: (v) => ({
        position: 'absolute', left: `${Math.round(v * 100)}%`, top: -3, bottom: -3,
        width: 2, background: 'rgba(127,127,127,0.75)', borderRadius: 1,
      }),
      num: { width: 46, textAlign: 'right', fontSize: 11, fontFamily: 'monospace', opacity: 0.75, flexShrink: 0 },
      tag: (kind) => ({
        display: 'inline-block', padding: '1px 6px', borderRadius: 4, fontSize: 10,
        marginRight: 6, background: 'rgba(127,127,127,0.16)',
        color: kind === 'mutation' ? '#d29922' : undefined,
      }),
      card: {
        border: '1px solid rgba(127,127,127,0.22)', borderRadius: 8,
        padding: '10px 12px', marginTop: 8, fontSize: 11, lineHeight: '17px',
      },
      err: { color: '#d1242f', fontSize: 12, marginTop: 8 },
      // 开关：用一个可点的圆角条，文案在左，状态在右
      sw: (on) => ({
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '7px 10px', margin: '6px 0', borderRadius: 7, fontSize: 12,
        border: '1px solid rgba(127,127,127,0.26)',
        background: on ? 'rgba(46,160,67,0.10)' : 'rgba(127,127,127,0.06)',
        cursor: 'pointer',
      }),
      swDot: (on) => ({
        width: 30, height: 16, borderRadius: 8, position: 'relative',
        background: on ? '#2ea043' : 'rgba(127,127,127,0.35)',
        transition: 'background .2s', flexShrink: 0,
      }),
      swKnob: (on) => ({
        position: 'absolute', top: 2, left: on ? 16 : 2,
        width: 12, height: 12, borderRadius: '50%', background: '#fff',
        transition: 'left .2s',
      }),
      exItem: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '5px 8px', margin: '4px 0', borderRadius: 5, fontSize: 11,
        background: 'rgba(127,127,127,0.08)', fontFamily: 'monospace',
      },
      exDel: {
        cursor: 'pointer', opacity: 0.55, padding: '0 4px', fontSize: 13,
        lineHeight: '14px', flexShrink: 0,
      },
      // 下拉框：撑满剩余宽度，与旁边的按钮同一行
      select: {
        flex: '1 1 auto', minWidth: 0, padding: '5px 6px', fontSize: 11,
        borderRadius: 5, border: '1px solid rgba(127,127,127,0.28)',
        background: 'transparent', color: 'inherit',
      },
      input: {
        flex: '1 1 auto', minWidth: 0, padding: '5px 8px', fontSize: 11,
        borderRadius: 5, border: '1px solid rgba(127,127,127,0.28)',
        background: 'transparent', color: 'inherit', fontFamily: 'monospace',
      },
      btn: {
        padding: '5px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.32)', background: 'transparent',
        color: 'inherit',
      },
    };

    const AXIS_LABEL = {
      warmth: '温度',
      volatility: '情绪起伏',
      guardedness: '戒备',
      playfulness: '玩笑',
      dependence: '依赖',
    };
    const AXIS_ORDER = ['warmth', 'volatility', 'guardedness', 'playfulness', 'dependence'];

    /**
     * 判定来源徽标。
     *
     * 四种来源对可信度的影响完全不同：
     *   模型  —— 正常路径，最可信
     *   缓存  —— 同一句话之前判过，结果一致
     *   规则  —— 应声词短路（嗯/哦），不值得调模型
     *   兜底  —— **模型失败后的降级，可能完全不准**
     *
     * 只有兜底需要警示，其余用平静的小字标注即可。
     */
    function judgeBadge(row) {
      const src = row.judge?.valenceSource;
      const degraded = row.judge?.degraded === true;
      if (!row.judge) return null;   // 旧记录没有诊断字段

      const label = degraded ? '规则兜底'
        : row.source === 'model' || row.source === 'llm' ? '模型'
        : row.source === 'cache' ? '缓存'
        : row.source === 'rule' ? '规则短路'
        : row.source ? String(row.source) : null;
      if (!label) return null;

      return h('span', {
        key: 'src',
        title: src === 'dictionary' ? '效价由词典计算' : '效价由模型给出',
        style: {
          marginLeft: 6, fontSize: 9, padding: '1px 5px', borderRadius: 3,
          background: degraded ? 'rgba(210,153,34,0.18)' : 'rgba(127,127,127,0.14)',
          color: degraded ? '#d29922' : 'inherit',
          opacity: degraded ? 1 : 0.6,
        },
      }, label);
    }

    /** 一根轴：当前值 + 基线刻度 */
    function AxisBar({ axis, value, baseline }) {
      return h('div', { style: C.row }, [
        h('div', { style: C.name, key: 'n' }, AXIS_LABEL[axis] || axis),
        h('div', { style: C.track, key: 't' }, [
          h('div', { key: 'f', style: C.fill(value) }),
          baseline !== undefined ? h('div', { key: 'm', style: C.mark(baseline), title: `基线 ${baseline.toFixed(2)}` }) : null,
        ]),
        h('div', { style: C.num, key: 'v' }, value.toFixed(2)),
      ]);
    }

    /** 人格面板主组件 */
    function PersonaPanel() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [ledger, setLedger] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [showAll, setShowAll] = React.useState(false);
      // 下拉框选中值 —— 必须与其它 hooks 并列在组件顶层。
      // 早期版本把它们放在"排除规则"块内（在 early return 之后），
      // 导致 hook 调用数随渲染变化 → React 抛错 → 整个面板空白。
      const [pickWs, setPickWs] = React.useState('');
      const [pickSid, setPickSid] = React.useState('');
      // 手动添加锚点的输入
      const [newAnchor, setNewAnchor] = React.useState('');
      // 身份编辑：本地草稿，保存前不影响真实状态
      const [draftName, setDraftName] = React.useState(null);
      const [draftUserName, setDraftUserName] = React.useState(null);
      // 角色设定：多行文本，单独草稿
      const [draftRole, setDraftRole] = React.useState(null);

      const load = React.useCallback(async () => {
        try {
          setError(null);
          const r = await callRpc('state');
          if (!r?.ok) throw new Error(r?.error?.message ?? '端点无响应');
          setData(r.value);
        } catch (err) {
          setError(err?.message ?? String(err));
        }
      }, []);

      const loadLedger = React.useCallback(async (limit) => {
        try {
          const r = await callRpc('ledger', { limit: limit ?? 10 });
          if (r?.ok) setLedger(r.value?.entries ?? []);
        } catch {
          setLedger([]);
        }
      }, []);

      React.useEffect(() => { void load(); void loadLedger(10); }, [load, loadLedger]);

      const refreshAll = async () => {
        setBusy(true);
        await load();
        await loadLedger(showAll ? 200 : 10);
        setBusy(false);
      };

      /**
       * 保存身份。改成即时可见：保存后面板与注入内容一起刷新。
       * 用 draft 而非直接改 data —— 允许"改了一半又放弃"。
       */
      const saveIdentity = async () => {
        const patch = {};
        if (draftName !== null) patch.name = draftName;
        if (draftUserName !== null) patch.userName = draftUserName;
        if (draftRole !== null) patch.role = draftRole;
        if (Object.keys(patch).length === 0) return;
        try {
          const r = await callRpc('identity', patch);
          if (!r?.ok) throw new Error(r?.error?.message ?? '保存失败');
          setData((cur) => ({ ...cur, identity: r.value.identity }));
          setDraftName(null);
          setDraftUserName(null);
          setDraftRole(null);
          await load();
          await loadLedger(showAll ? 200 : 10);
        } catch (err) {
          setError(err?.message ?? String(err));
        }
      };

      /** 提交排除规则（整列表替换，语义最明确） */
      const saveExclusions = async (patch) => {
        try {
          const r = await callRpc('exclusions', patch);
          if (!r?.ok) throw new Error(r?.error?.message ?? '保存失败');
          setData((cur) => ({ ...cur, exclusions: r.value.exclusions }));
          await loadLedger(showAll ? 200 : 10);
        } catch (err) {
          setError(err?.message ?? String(err));
        }
      };

      /**
       * 切换开关。乐观更新：先改本地再请求，失败时回滚并显示错误。
       * 关掉注入是即时生效的（下一次 prompt 装配就会看到空 section）。
       */
      const setSwitch = async (key, value) => {
        const prev = data;
        setData({ ...data, enabled: { ...(data.enabled ?? {}), [key]: value } });
        try {
          const r = await callRpc('toggle', { [key]: value });
          if (!r?.ok) throw new Error(r?.error?.message ?? '切换失败');
          setData((cur) => ({ ...cur, enabled: r.value.enabled }));
          await loadLedger(showAll ? 200 : 10);
        } catch (err) {
          setData(prev);
          setError(err?.message ?? String(err));
        }
      };

      if (error) {
        return h('div', { style: C.wrap }, [
          h('div', { key: 'e', style: C.err }, `获取状态失败：${error}`),
          h('button', { key: 'b', style: C.btn, onClick: refreshAll }, '重试'),
        ]);
      }
      if (!data) return h('div', { style: C.wrap }, '加载中…');

      const traits = data.traits ?? {};
      const baseline = data.baseline ?? {};
      const changed = data.changed ?? [];

      const children = [];

      // 标题
      const ident = data.identity ?? { name: '', userName: '' };
      const shownName = draftName !== null ? draftName : (ident.name || '');
      children.push(h('div', { key: 'title', style: C.h },
        `人格 · ${ident.name || '未命名'}`));
      children.push(h('div', { key: 'sub', style: C.sub },
        `已对话 ${data.turns || 0} 轮 · 变更 ${data.revision || 0} 次 · 突变 ${data.mutations || 0} 次`));

      // --- 身份 ---
      children.push(h('div', { key: 'id-h', style: C.h }, '身份'));
      children.push(h('div', { key: 'id-sub', style: C.sub },
        '它叫什么、它怎么称呼你。改完立即生效，不需要重启。'));

      children.push(h('div', { key: 'id-name', style: C.row }, [
        h('div', { key: 'l', style: C.name }, '它叫'),
        h('input', {
          key: 'i', style: C.input, value: shownName, placeholder: '给它起个名字',
          maxLength: 40,
          onChange: (e) => setDraftName(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') void saveIdentity(); },
        }),
      ]));
      children.push(h('div', { key: 'id-user', style: C.row }, [
        h('div', { key: 'l', style: C.name }, '它叫你'),
        h('input', {
          key: 'i', style: C.input,
          value: draftUserName !== null ? draftUserName : (ident.userName || ''),
          placeholder: '你的称呼（可留空）',
          maxLength: 40,
          onChange: (e) => setDraftUserName(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') void saveIdentity(); },
        }),
      ]));
      // 角色设定：决定"用什么姿态说话"，是语气问题的根子
      children.push(h('div', { key: 'id-role-l', style: { ...C.sub, marginTop: 10 } },
        '角色设定 —— 它是什么样的人、怎么说话。这段会每轮注入，'
          + '比一次性提示词有效得多。'));
      children.push(h('textarea', {
        key: 'id-role',
        style: {
          width: '100%', minHeight: 140, padding: '8px 10px', fontSize: 11,
          lineHeight: '18px', borderRadius: 6, boxSizing: 'border-box',
          border: '1px solid rgba(127,127,127,0.28)',
          background: 'rgba(127,127,127,0.04)', color: 'inherit',
          fontFamily: 'inherit', resize: 'vertical',
        },
        value: draftRole !== null ? draftRole : (ident.role || ''),
        placeholder: '例如：你是……\n说话方式：……',
        maxLength: 3000,
        onChange: (e) => setDraftRole(e.target.value),
      }));

      if (draftName !== null || draftUserName !== null || draftRole !== null) {
        children.push(h('div', { key: 'id-act', style: C.row }, [
          h('button', { key: 's', style: C.btn, onClick: () => void saveIdentity() }, '保存'),
          h('button', {
            key: 'c', style: C.btn,
            onClick: () => { setDraftName(null); setDraftUserName(null); setDraftRole(null); },
          }, '取消'),
        ]));
      }

      // 特质条
      children.push(h('div', { key: 'traits' },
        AXIS_ORDER.map((axis) => h(AxisBar, {
          key: axis, axis, value: traits[axis] ?? 0, baseline: baseline[axis],
        }))));

      // 变化摘要（来自表达层）
      if (changed.length > 0) {
        children.push(h('div', { key: 'chg-h', style: C.h }, '相比最初'));
        children.push(h('div', { key: 'chg', style: C.sub },
          changed.map((c) => `${AXIS_LABEL[c.axis] || c.axis} ${c.adjective}`).join(' · ')));
      } else {
        children.push(h('div', { key: 'chg', style: C.sub }, '性情还没有明显变化，和最初差不太多。'));
      }

      // 状态指标
      children.push(h('div', { key: 'state-h', style: C.h }, '当前状态'));
      children.push(h('div', { key: 'state', style: C.sub },
        `累积负荷 ${(data.load ?? 0).toFixed(3)} · 易感性 ${(data.sensitivity ?? 0).toFixed(3)}`
          + (data.cooldown > 0 ? ` · 突变冷却 ${data.cooldown} 轮` : '')));

      // 突变进度（v0.3）
      // 突变要五个条件同时满足，其中"关系损伤"和"负性事件数"最容易让人困惑
      // ——「为什么吵了这么多次还没变？」，所以单独显示进度。
      {
        const trust = data.trustDamage ?? 0;
        const events = data.negativeSinceMutation ?? 0;
        const TRUST_NEED = 0.60;
        const EVENTS_NEED = 3;
        const trustOk = trust >= TRUST_NEED;
        const eventsOk = events >= EVENTS_NEED;
        if (trust > 0.02 || events > 0) {
          children.push(h('div', { key: 'mut-h', style: C.h }, '突变进度'));
          children.push(h('div', { key: 'mut-t', style: C.sub }, [
            h('div', { key: 'tr' },
              `关系损伤 ${trust.toFixed(2)} / ${TRUST_NEED}  ${trustOk ? '✅' : ''}`),
            h('div', { key: 'ev' },
              `负性事件 ${events} / ${EVENTS_NEED} 次  ${eventsOk ? '✅' : ''}`),
            h('div', { key: 'note', style: { marginTop: 4, opacity: 0.65 } },
              '突变还需「冲击够强 + 负荷够高 + 易感够高」同时成立；'
                + '单次事件无论多重都不会触发。'),
          ]));
        }
      }

      // 开关
      const en = data.enabled ?? { inject: true, evolve: true };
      children.push(h('div', { key: 'sw-h', style: C.h }, '开关'));
      children.push(h('div', {
        key: 'sw-inject', style: C.sw(en.inject),
        onClick: () => void setSwitch('inject', !en.inject),
      }, [
        h('span', { key: 'l' }, [
          '注入人格段',
          h('div', { key: 'd', style: { fontSize: 10, opacity: 0.55, marginTop: 2 } },
            en.inject ? '模型会读到你的人格设定' : '模型看不到人格设定（状态保留，可随时恢复）'),
        ]),
        h('div', { key: 't', style: C.swDot(en.inject) },
          h('div', { style: C.swKnob(en.inject) })),
      ]));
      children.push(h('div', {
        key: 'sw-evolve', style: C.sw(en.evolve),
        onClick: () => void setSwitch('evolve', !en.evolve),
      }, [
        h('span', { key: 'l' }, [
          '继续演化',
          h('div', { key: 'd', style: { fontSize: 10, opacity: 0.55, marginTop: 2 } },
            en.evolve ? '对话会影响它的人格' : '人格已冻结，对话照常进行但不改变它'),
        ]),
        h('div', { key: 't', style: C.swDot(en.evolve) },
          h('div', { style: C.swKnob(en.evolve) })),
      ]));

      // 记忆锚点开关
      const anchorOn = en.anchor !== false;
      children.push(h('div', {
        key: 'sw-anchor', style: C.sw(anchorOn),
        onClick: () => void setSwitch('anchor', !anchorOn),
      }, [
        h('span', { key: 'l' }, [
          '记忆锚点',
          h('div', { key: 'd', style: { fontSize: 10, opacity: 0.55, marginTop: 2 } },
            anchorOn
              ? '从对话里抽取情感事件，提及相关词时会"想起"'
              : '已关闭：不再抽取、不再注入回忆（已有锚点保留，可随时恢复）'),
        ]),
        h('div', { key: 't', style: C.swDot(anchorOn) },
          h('div', { style: C.swKnob(anchorOn) })),
      ]));

      // 冲突提示：仅在启用时显示
      if (anchorOn) {
        children.push(h('div', {
          key: 'anchor-conflict-hint',
          style: {
            marginTop: 6, padding: '8px 10px', borderRadius: 6, fontSize: 11,
            lineHeight: '17px',
            background: 'rgba(210,153,34,0.08)',
            border: '1px solid rgba(210,153,34,0.25)',
            color: 'inherit', opacity: 0.85,
          },
        }, [
          h('div', { key: 'h', style: { fontWeight: 600, marginBottom: 3 } },
            '⚠ 与其他记忆插件同时启用时'),
          h('div', { key: 'b' },
            '如果另外装了带"锚点"或"回忆"功能的记忆插件（它们也会在相关词出现时注入往事），'
            + '两边的回忆可能重复出现，导致同一件事被提起两次。'
            + '这种情况下建议关闭本插件的记忆锚点，只保留一个来源。'),
          h('div', { key: 'f', style: { marginTop: 4, opacity: 0.7 } },
            '关闭不会删除已有锚点 —— 重新打开即恢复。'),
        ]));
      }

      // 判定通道
      //
      // 为什么需要这个：事件判定默认跟随会话模型，但 config 里可以写死一条通道。
      // 写死的好处是判定稳定、不受主对话换模型影响；坏处是那条通道故障时
      // 判定全挂，而界面上看不出来。给个下拉框，两边都能选。
      {
        const cur = data.judgeRoute;
        const eff = data.judgeEffective;
        const models = data.judgeModels ?? [];
        // 回显：按 provider+model 精确匹配，找不到就空（跟随）
        const curIdx = cur
          ? models.findIndex((m) => m.provider === cur.provider && m.model === cur.model)
          : -1;
        const curKey = curIdx >= 0 ? `i:${curIdx}` : '';

        children.push(h('div', { key: 'jr-h', style: C.h }, '事件判定通道'));
        children.push(h('div', { key: 'jr-sub', style: C.sub },
          '用哪个模型判断"这句话是什么类型的情感事件"。判定走异步旁路，不影响对话速度。'));

        const options = [h('option', { key: '__follow', value: '' }, '跟随会话模型')];
        for (const [idx, m] of models.entries()) {
          options.push(h('option', {
            key: `${m.provider}/${m.model}`,
            // 用索引做 value，不用 "provider/model" 拼接。
            //
            // 原因：模型 id 本身常带斜杠（qodercn/dfmodel、trae/deepseek-v4.1-flash），
            // 拼成 "dsh-ofm/qodercn/dfmodel" 后再用 lastIndexOf('/') 切，
            // 会得到 provider="dsh-ofm/qodercn" —— 一个不存在的路由，静默失败。
            value: `i:${idx}`,
          }, m.name && m.name !== m.model ? `${m.name}` : m.model));
        }

        children.push(h('div', { key: 'jr-row', style: C.card }, [
          h('div', { key: 'sel', style: C.row }, [
            h('div', { key: 'l', style: { ...C.name, width: 84 } }, '判定用'),
            h('select', {
              key: 's', style: { ...C.select, flex: '1 1 auto' },
              value: curKey,
              onChange: async (e) => {
                const v = e.target.value;
                try {
                  if (v === '') {
                    await callRpc('judge-route', { follow: true });
                  } else {
                    // value 是 `i:<索引>`，从列表原样取回 provider/model，
                    // 不做字符串切分 —— 模型 id 里的斜杠不会再造成误解析
                    const picked = models[Number(String(v).slice(2))];
                    if (!picked) throw new Error('选项已失效，请刷新');
                    await callRpc('judge-route', {
                      provider: picked.provider,
                      model: picked.model,
                    });
                  }
                  await load();
                } catch (err) { setError(err?.message ?? String(err)); }
              },
            }, options),
          ]),
          // 当前实际生效的通道
          h('div', { key: 'eff', style: { ...C.sub, marginTop: 6, marginBottom: 0 } },
            eff ? `当前生效：${eff.provider}/${eff.model}`
                : '当前生效：未知（没有可用的模型路由）'),
          data.judgeError
            ? h('div', { key: 'err', style: { ...C.sub, marginTop: 4, marginBottom: 0, color: '#d1242f' } },
                `模型列表获取失败：${data.judgeError}`)
            : null,
          models.length === 0 && !data.judgeError
            ? h('div', { key: 'none', style: { ...C.sub, marginTop: 4, marginBottom: 0 } },
                '没有列出可选模型 —— 会回落到配置文件里的通道。')
            : null,
          // 写死通道时提醒：该通道出问题判定会一直降级
          cur
            ? h('div', {
                key: 'pin', style: { ...C.sub, marginTop: 4, marginBottom: 0, opacity: 0.75 },
              }, '已写死该通道：它不可用时判定会降级到关键词规则，而不会自动跟随会话模型。')
            : null,
        ].filter(Boolean)));
      }

      // 人格段预览（模型实际看到的内容）
      children.push(h('div', { key: 'prev-h', style: C.h }, '模型的自我认知（注入内容）'));
      if (en.inject === false) {
        children.push(h('div', { key: 'prev-off', style: { ...C.card, opacity: 0.6 } },
          '已关闭注入：这段内容当前不会出现在模型上下文里。'));
      } else if (data.rendered) {
        children.push(h('div', { key: 'prev', style: C.card }, data.rendered));
      }

      // 排除规则
      const ex = data.exclusions ?? { workspaces: [], sessions: [], presets: [] };
      const cand = data.candidates ?? { workspaces: [], sessions: [] };
      const totalEx = ex.workspaces.length + ex.sessions.length + ex.presets.length;

      children.push(h('div', { key: 'ex-h', style: C.h },
        `不参与人格形成的会话${totalEx > 0 ? `（${totalEx} 条）` : ''}`));
      children.push(h('div', { key: 'ex-sub', style: C.sub },
        '被排除的对话照常进行，只是不影响人格。subagent 会话一律不参与。'));

      // --- 工作区：下拉选择 ---
      children.push(h('div', { key: 'ex-ws-l', style: { ...C.sub, marginTop: 8 } }, '按工作区'));
      if (ex.workspaces.length === 0) {
        children.push(h('div', { key: 'ex-ws-0', style: { ...C.sub, opacity: 0.45 } }, '（无）'));
      } else {
        children.push(h('div', { key: 'ex-ws' }, ex.workspaces.map((w) => h('div', { key: w, style: C.exItem }, [
          h('span', { key: 't', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, w),
          h('span', {
            key: 'x', style: C.exDel, title: '移除',
            onClick: () => void saveExclusions({ workspaces: ex.workspaces.filter((x) => x !== w) }),
          }, '×'),
        ]))));
      }
      {
        // 可选工作区：排除已加入的
        const avail = cand.workspaces.filter((w) => !ex.workspaces.includes(w.path));
        children.push(h('div', { key: 'ex-ws-pick', style: { ...C.row, marginTop: 4 } }, [
          h('select', {
            key: 's', style: C.select, value: pickWs,
            onChange: (e) => setPickWs(e.target.value),
          }, [
            h('option', { key: '', value: '' }, avail.length ? `选择工作区（${avail.length} 个）` : '没有可选的工作区'),
            ...avail.map((w) => h('option', { key: w.path, value: w.path }, w.title || w.path)),
          ]),
          h('button', {
            key: 'b', style: C.btn, disabled: !pickWs,
            onClick: () => {
              if (!pickWs) return;
              void saveExclusions({ workspaces: [...ex.workspaces, pickWs] });
              setPickWs('');
            },
          }, '加入排除'),
        ]));
      }

      // --- 会话：下拉选择 ---
      children.push(h('div', { key: 'ex-sd-l', style: { ...C.sub, marginTop: 10 } }, '按会话'));
      if (ex.sessions.length === 0) {
        children.push(h('div', { key: 'ex-sd-0', style: { ...C.sub, opacity: 0.45 } }, '（无）'));
      } else {
        children.push(h('div', { key: 'ex-sd' }, ex.sessions.map((sid) => h('div', { key: sid, style: C.exItem }, [
          h('span', { key: 't', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sid),
          h('span', {
            key: 'x', style: C.exDel, title: '移除',
            onClick: () => void saveExclusions({ sessions: ex.sessions.filter((x) => x !== sid) }),
          }, '×'),
        ]))));
      }
      {
        const avail = cand.sessions.filter((s) => !ex.sessions.includes(s.id));
        children.push(h('div', { key: 'ex-sd-pick', style: { ...C.row, marginTop: 4 } }, [
          h('select', {
            key: 's', style: C.select, value: pickSid,
            onChange: (e) => setPickSid(e.target.value),
          }, [
            h('option', { key: '', value: '' }, avail.length ? `选择会话（${avail.length} 个）` : '没有可选的会话'),
            ...avail.map((s) => {
              const when = s.createdAt ? new Date(s.createdAt).toLocaleDateString() : '';
              const dir = s.cwd ? s.cwd.split('/').filter(Boolean).slice(-1)[0] || s.cwd : '';
              const tag = s.isSubagent ? ' [subagent]' : '';
              return h('option', { key: s.id, value: s.id },
                `${when} ${dir}${tag} · ${s.id.slice(0, 14)}…`);
            }),
          ]),
          h('button', {
            key: 'b', style: C.btn, disabled: !pickSid,
            onClick: () => {
              if (!pickSid) return;
              void saveExclusions({ sessions: [...ex.sessions, pickSid] });
              setPickSid('');
            },
          }, '加入排除'),
        ]));
      }

      
      // --- 记忆锚点 ---
      const anch = data.anchors ?? [];
      const excl = data.exclusion ?? null;

      // 即使没有锚点也要显示这一块 —— 空和"功能坏了"必须能区分开。
      // 之前的写法是 `if (anch.length > 0)` 才渲染，结果被排除规则拦下时
      // 整块消失，用户只会以为功能没生效。
      {
        const stateLabel = { open: '悬着', resolved: '已解决', faded: '已淡出' };
        const stateColor = { open: '#d29922', resolved: '#2ea043', faded: 'rgba(127,127,127,0.6)' };
        children.push(h('div', { key: 'anc-h', style: C.h },
          `记忆锚点（${anch.length} 条）`));
        children.push(h('div', { key: 'anc-sub', style: C.sub },
          '从对话里自动抽取的情感事件。命中相关词时会被"想起"，注入给模型。'));

        // 空态：先解释原因，再给结论
        if (anch.length === 0) {
          let why;
          if (excl?.excluded) {
            why = `当前会话被排除（${excl.reason}），所以不会产生锚点。`;
          } else if (!data.anchorEnabled) {
            why = '锚点功能已关闭。';
          } else {
            why = '还没有值得记住的事。示弱、丧失、背叛这类事件才会形成锚点 ——'
              + '日常寒暄和轻微抱怨不会。';
          }
          children.push(h('div', { key: 'anc-empty', style: { ...C.card, opacity: 0.7 } }, why));
        }

        for (const a of anch.slice().sort((x, y) => (y.when ?? 0) - (x.when ?? 0))) {
          const when = a.when ? new Date(a.when).toLocaleDateString() : '';
          children.push(h('div', { key: a.id, style: { ...C.card, marginTop: 6 } }, [
            h('div', { key: 'top', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
              h('span', {
                key: 's',
                style: {
                  fontSize: 10, padding: '1px 5px', borderRadius: 3,
                  color: stateColor[a.state] ?? 'inherit',
                  border: `1px solid ${stateColor[a.state] ?? 'rgba(127,127,127,0.3)'}`,
                },
              }, stateLabel[a.state] ?? a.state),
              h('span', { key: 'n', style: { fontWeight: 600 } }, a.summary),
              h('span', { key: 'w', style: { marginLeft: 'auto', opacity: 0.5, fontSize: 10 } },
                `${when} · 权重 ${(a.weight ?? 0).toFixed(2)}`),
            ]),
            a.resolutionNote
              ? h('div', { key: 'r', style: { marginTop: 4, opacity: 0.7, fontSize: 11 } },
                  `↳ 后来：${a.resolutionNote}`)
              : null,
            h('div', { key: 'meta', style: { marginTop: 4, opacity: 0.55, fontSize: 10 } },
              `提到过 ${a.mentionCount ?? 0} 次 · 被想起 ${a.recalledCount ?? 0} 次`),
            h('div', { key: 'act', style: { marginTop: 6, display: 'flex', gap: 6 } }, [
              a.state === 'open'
                ? h('button', {
                    key: 'res', style: { ...C.btn, fontSize: 11, padding: '3px 8px' },
                    onClick: async () => {
                      const note = window.prompt('后来怎么样了？（可留空）', '');
                      if (note === null) return;
                      try {
                        await callRpc('anchor', { id: a.id, action: 'resolve', note });
                        await load();
                      } catch (err) { setError(err?.message ?? String(err)); }
                    },
                  }, '标记已解决')
                : null,
              a.state === 'resolved'
                ? h('button', {
                    key: 'ro', style: { ...C.btn, fontSize: 11, padding: '3px 8px' },
                    onClick: async () => {
                      try {
                        await callRpc('anchor', { id: a.id, action: 'reopen' });
                        await load();
                      } catch (err) { setError(err?.message ?? String(err)); }
                    },
                  }, '重新打开')
                : null,
              a.state !== 'faded'
                ? h('button', {
                    key: 'fd', style: { ...C.btn, fontSize: 11, padding: '3px 8px' },
                    onClick: async () => {
                      try {
                        await callRpc('anchor', { id: a.id, action: 'fade' });
                        await load();
                      } catch (err) { setError(err?.message ?? String(err)); }
                    },
                  }, '淡出')
                : null,
              a.state === 'faded'
                ? h('button', {
                    key: 'rv', style: { ...C.btn, fontSize: 11, padding: '3px 8px' },
                    onClick: async () => {
                      try {
                        await callRpc('anchor', { id: a.id, action: 'revive' });
                        await load();
                      } catch (err) { setError(err?.message ?? String(err)); }
                    },
                  }, '复活')
                : null,
              h('button', {
                key: 'del', style: { ...C.btn, fontSize: 11, padding: '3px 8px', opacity: 0.7 },
                onClick: async () => {
                  if (!window.confirm(`删除「${a.summary}」？这一步不可撤销。`)) return;
                  try {
                    await callRpc('anchor', { id: a.id, action: 'delete' });
                    await load();
                  } catch (err) { setError(err?.message ?? String(err)); }
                },
              }, '删除'),
            ].filter(Boolean)),
          ]));
        }

        // 手动添加：给用户的控制权 —— 自动判据抓不到的，人可以主动说"记住"
        children.push(h('div', { key: 'anc-add', style: { ...C.row, marginTop: 8 } }, [
          h('input', {
            key: 'i', style: C.input, value: newAnchor,
            placeholder: '手动记住一件事（如"我妈住院了"）',
            maxLength: 60,
            onChange: (e) => setNewAnchor(e.target.value),
            onKeyDown: async (e) => {
              if (e.key !== 'Enter' || !newAnchor.trim()) return;
              try {
                await callRpc('anchor', { action: 'create', summary: newAnchor.trim() });
                setNewAnchor('');
                await load();
                await loadLedger(showAll ? 200 : 10);
              } catch (err) { setError(err?.message ?? String(err)); }
            },
          }),
          h('button', {
            key: 'b', style: C.btn, disabled: !newAnchor.trim(),
            onClick: async () => {
              if (!newAnchor.trim()) return;
              try {
                await callRpc('anchor', { action: 'create', summary: newAnchor.trim() });
                setNewAnchor('');
                await load();
                await loadLedger(showAll ? 200 : 10);
              } catch (err) { setError(err?.message ?? String(err)); }
            },
          }, '记住'),
        ]));
      }

      // LLM 用量（只统计本插件自己发起的调用）
      const usage = data.usage;
      if (usage && usage.totals) {
        const t = usage.totals;
        const fmt = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n));
        // 复用本插件已有的 C.tag 与行内布局，不引入新的样式基元
        const kv = (key, label, value) => h('div', { key, style: C.row }, [
          h('div', { key: 'k', style: C.name }, label),
          h('div', { key: 'v', style: { fontSize: 11, flex: '1 1 auto' } }, value),
        ]);

        children.push(h('div', { key: 'us-h', style: C.h }, 'LLM 用量'));
        children.push(h('div', { key: 'us-sub', style: C.sub },
          '只统计人格插件自己发起的调用（事件判定、锚点解决检测），不含主对话。'));

        const head = [
          h('span', { key: 'a', style: C.tag('normal') }, `调用 ${t.calls} 次`),
        ];
        if (t.failures > 0) {
          head.push(h('span', { key: 'b', style: C.tag('mutation') }, `失败 ${t.failures}`));
        }
        head.push(h('span', {
          key: 'c',
          style: { fontSize: 10, opacity: 0.55 },
        }, `运行 ${Math.round((t.uptimeMs ?? 0) / 60000)} 分钟`));

        children.push(h('div', { key: 'us-card', style: C.card }, [
          h('div', { key: 'head', style: { marginBottom: 6 } }, head),
          kv('i', '输入', fmt(t.inputTokens) + ' tokens'),
          kv('o', '输出', fmt(t.outputTokens) + ' tokens'),
          kv('t', '合计', fmt(t.totalTokens) + ' tokens'),
        ]));

        const bucketRows = Object.entries(usage.buckets ?? {})
          .filter(([, v]) => v.calls > 0)
          .map(([k, v]) => {
            const label = k === 'judge' ? '事件判定' : k === 'anchor-resolve' ? '锚点解决' : k;
            return kv(k, label, `${v.calls} 次 · ${fmt(v.totalTokens)} tokens${v.failures ? ` · ${v.failures} 失败` : ''}`);
          });
        if (bucketRows.length > 0) {
          children.push(h('div', { key: 'us-b', style: C.card }, bucketRows));
        }

        const missing = (usage.recent ?? []).filter((r) => r.missing).length;
        if (missing > 0) {
          children.push(h('div', { key: 'us-miss', style: { ...C.sub, marginTop: 6 } },
            `注意：最近 ${missing} 次调用没有返回 usage —— 适配器未提供，这部分未计入。`));
        }

        children.push(h('div', { key: 'us-btn', style: C.row }, [
          h('button', {
            key: 'r', style: C.btn,
            onClick: async () => {
              try {
                await callRpc('reset-usage');
                await load();
              } catch (err) { setError(err?.message ?? String(err)); }
            },
          }, '清零'),
        ]));
      }

      // 最近变更
      children.push(h('div', { key: 'lg-h', style: C.h }, '最近变更'));
      if (ledger === null) {
        children.push(h('div', { key: 'lg-load', style: C.sub }, '加载中…'));
      } else if (ledger.length === 0) {
        children.push(h('div', { key: 'lg-empty', style: C.sub }, '还没有记录。'));
      } else {
        children.push(h('div', { key: 'lg' }, ledger.map((row, i) => {
          const mut = row.transition?.mutated;
          const drift = row.transition?.drift ?? {};
          const bond = row.transition?.bond ?? {};
          const moved = Object.keys(drift).length + Object.keys(bond).length;
          const at = row.at ? new Date(row.at).toLocaleString() : '';
          return h('div', { key: i, style: { ...C.card, marginTop: 6 } }, [
            h('div', { key: 'top' }, [
              h('span', { key: 'k', style: C.tag(mut ? 'mutation' : 'drift') }, row.kind || '?'),
              h('span', { key: 't', style: { opacity: 0.6 } }, at),
              // 判定来源：出问题时一眼看出这次是模型判的、缓存的，还是降级兜底的。
              //
              // 之前只显示 kind 和 evidence —— 一句明显夸赞被判 routine 时，
              // 看不出"是真的中性"还是"模型失败了退回规则"，
              // 要翻 ledger 原始 JSON 才能确认。
              judgeBadge(row),
            ].filter(Boolean)),

            // 降级时给出明确警告：结果可能不准
            row.judge?.degraded
              ? h('div', {
                  key: 'deg',
                  style: {
                    marginTop: 4, padding: '4px 8px', borderRadius: 5, fontSize: 10,
                    background: 'rgba(210,153,34,0.12)',
                    border: '1px solid rgba(210,153,34,0.3)',
                    lineHeight: '15px',
                  },
                }, [
                  h('div', { key: 'h', style: { fontWeight: 600 } }, '⚠ 规则兜底（模型判定失败）'),
                  h('div', { key: 'r', style: { opacity: 0.75, marginTop: 2 } },
                    row.judge.reason ? String(row.judge.reason).slice(0, 90) : '原因未记录'),
                  h('div', { key: 's', style: { opacity: 0.6, marginTop: 2 } },
                    '这一条的事件类型和效价由关键词规则推定，可能不准。'),
                ])
              : null,
            mut
              ? h('div', { key: 'm', style: { marginTop: 4, color: '#d29922' } },
                  `★ 突变：${Object.entries(mut.delta || {}).map(([k, v]) => `${AXIS_LABEL[k] || k} ${v > 0 ? '+' : ''}${v}`).join('，')}`)
              : (moved > 0
                ? h('div', { key: 'd', style: { marginTop: 4, opacity: 0.8 } },
                    `漂变：${Object.entries({ ...drift, ...bond }).map(([k, v]) => `${AXIS_LABEL[k] || k} ${v > 0 ? '+' : ''}${(v * 1).toFixed(4)}`).join('，')}`)
                : null),
            row.evidence
              ? h('div', { key: 'e', style: { marginTop: 4, opacity: 0.55, fontSize: 10 } }, `“${row.evidence}”`)
              : null,
          ]);
        })));
      }

      // 操作区
      children.push(h('div', { key: 'act', style: { ...C.row, marginTop: 12 } }, [
        h('button', { key: 'r', style: C.btn, disabled: busy, onClick: refreshAll }, busy ? '刷新中…' : '刷新'),
        h('button', {
          key: 'm', style: C.btn,
          onClick: async () => {
            const next = !showAll;
            setShowAll(next);
            await loadLedger(next ? 200 : 10);
          },
        }, showAll ? '只看最近' : '查看全部'),
      ]));

      return h('div', { style: C.wrap }, children);
    }

    // ---------------------------------------------------------------------
    // 插件入口
    // ---------------------------------------------------------------------

    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'companion-persona',
        order: 25,          // models 是 order:10，这里排在它之后、贴近记忆面板
        label: '人格',
        inject: () => ({}),
      }, PersonaPanel));
    }

    // 摊平成普通数据属性对象（loader 只按属性读取）
    const flat = {};
    for (const k in module.exports) flat[k] = module.exports[k];
    Object.defineProperty(flat, Symbol.toStringTag, { value: 'Module' });
    flat.apply = apply;
    flat.inject = inject;
    return flat;
  },
});
