/**
 * 人格面板（client bundle）。
 *
 * 格式必须与 DSH 的 ModuleLoader 契约一致：`window.__ModuleLoader__.load({id, factory})`，
 * 内部用 `require(name)` 取得宿主共享模块（react / react/jsx-runtime / slots）。
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
      // 身份编辑：本地草稿，保存前不影响真实状态
      const [draftName, setDraftName] = React.useState(null);
      const [draftUserName, setDraftUserName] = React.useState(null);

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
        if (Object.keys(patch).length === 0) return;
        try {
          const r = await callRpc('identity', patch);
          if (!r?.ok) throw new Error(r?.error?.message ?? '保存失败');
          setData((cur) => ({ ...cur, identity: r.value.identity }));
          setDraftName(null);
          setDraftUserName(null);
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
      if (draftName !== null || draftUserName !== null) {
        children.push(h('div', { key: 'id-act', style: C.row }, [
          h('button', { key: 's', style: C.btn, onClick: () => void saveIdentity() }, '保存'),
          h('button', {
            key: 'c', style: C.btn,
            onClick: () => { setDraftName(null); setDraftUserName(null); },
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
            ]),
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
        order: 25,          // 落在 20(models) 与 30 之间，靠近记忆面板
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
