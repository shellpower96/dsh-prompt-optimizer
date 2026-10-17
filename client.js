window.__ModuleLoader__.load({
  id: 'dsh-prompt-optimizer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 本地化命名空间（仅 UI 文案，与 Host 侧无关）。 */
    const NS = 'promptOptimizer';
    /** 命令名：必须与 Host 侧 index.js 的 COMMAND.name 一致。 */
    const COMMAND_NAME = 'optimize-prompt';
    /** 命令行前缀：命令名 + 一个分隔空白。 */
    const COMMAND_PREFIX = '/' + COMMAND_NAME + ' ';

    /**
     * 由 `apply` 注入的 Remote 调用闭包。
     *
     * 为什么用闭包而不是 slot props：`conversation.composer.dock` 的标准 props 里
     * 没有 `remote`（只有 useInput / inputActions / sessionId / useXxx 选择器），
     * 而 `apply(ctx)` 拿得到 `ctx.remote.commands`。
     */
    let executeOptimize = null;

    /** 提取输入框草稿的 selector（返回原始字符串，按值比较，不会触发重渲染风暴）。 */
    const selectDraft = (state) => (state && typeof state.draft === 'string' ? state.draft : '');
    /** 提取输入阶段：非 plain 时编辑器会拒绝改写草稿。 */
    const selectPhase = (state) => (state && typeof state.phase === 'string' ? state.phase : 'plain');

    /** 简体中文文案（key 集合的真源）。 */
    const zh = {
      'action.optimize': '智能提示词',
      'action.working': '优化中…',
      'action.done': '已优化',
      'action.aria': '结合当前项目规范，把输入框内容优化成结构化提示词',
      'error.generic': '优化失败，请重试。',
      'error.notRegistered': 'Host 侧没有注册 optimize-prompt 命令：插件可能未安装或未激活。',
      'row.title': '智能提示词',
      'row.pending': '生成中…',
      'row.failed': '失败',
      'row.chars': ' 字',
      'row.fill': '填入输入框',
    };

    /** English copy（key 集合与 zh 一致）。 */
    const en = {
      'action.optimize': 'Smart prompt',
      'action.working': 'Optimizing…',
      'action.done': 'Optimized',
      'action.aria': 'Rewrite the composer draft into a structured prompt using this project’s conventions',
      'error.generic': 'Optimization failed. Please try again.',
      'error.notRegistered': 'The optimize-prompt command is not registered on the Host: the plugin may be missing or inactive.',
      'row.title': 'Smart prompt',
      'row.pending': 'Generating…',
      'row.failed': 'Failed',
      'row.chars': ' chars',
      'row.fill': 'Fill composer',
    };

    /**
     * 组件内样式：只使用主题 token（`--dsw-alias-*`），浅色/深色自动跟随。
     * 作为 React 元素渲染，组件卸载即移除，不污染全局样式表。
     */
    const CSS = [
      '.po-dock{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 2px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.po-btn{display:inline-flex;align-items:center;gap:6px;padding:3px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:border-color 120ms ease,color 120ms ease;}',
      '.po-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.po-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.po-btn:disabled{cursor:progress;opacity:.65;}',
      '.po-btn[data-state="done"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
      '.po-spin{display:inline-block;width:10px;height:10px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:po-spin 700ms linear infinite;}',
      '@keyframes po-spin{to{transform:rotate(360deg);}}',
      '@media (prefers-reduced-motion: reduce){.po-spin{animation:none;}}',
      '.po-note{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.po-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary);}',
      '.po-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.po-row-title{color:var(--dsw-alias-label-primary);font-weight:500;}',
      '.po-row-fill{padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;}',
      '.po-row-fill:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.po-row-fill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
    ].join('');

    /**
     * 取本地化函数；locale 服务缺失时回退到内置中文文案。
     * @param {object} props - slot 组件 props。
     * @returns {(key: string) => string} 翻译函数。
     */
    function translateOf(props) {
      if (typeof props.t === 'function') return (key) => String(props.t(key) ?? zh[key] ?? key);
      return (key) => zh[key] ?? key;
    }

    /**
     * 输入框下方的「智能提示词」按钮。
     *
     * 草稿为空时不渲染；点击后调用 Host 命令 `/optimize-prompt`，
     * 成功则把优化结果整体回填输入框（`inputActions.setDraft`）。
     *
     * @param {object} props - dock slot props（useInput / inputActions / sessionId / t）。
     * @returns {object | null} React 元素。
     */
    function PromptOptimizerDock(props) {
      const tr = translateOf(props);
      // owner 保证提供这两个 standard prop；缺省时退化成常量，避免整条 slot entry 崩溃。
      const useInput = typeof props.useInput === 'function' ? props.useInput : () => undefined;
      const draft = useInput(selectDraft);
      const phase = useInput(selectPhase);
      const [status, setStatus] = React.useState('idle');
      const [note, setNote] = React.useState('');
      const [optimizedFor, setOptimizedFor] = React.useState('');
      const abortRef = React.useRef(null);
      const mountedRef = React.useRef(true);

      React.useEffect(() => () => {
        mountedRef.current = false;
        if (abortRef.current !== null) abortRef.current.abort();
      }, []);

      const text = typeof draft === 'string' ? draft.trim() : '';
      if (text.length === 0) return null;

      const busy = status === 'working';
      const locked = phase !== 'plain';
      const done = optimizedFor.length > 0 && optimizedFor === text;

      const run = async () => {
        if (busy || locked) return;
        if (typeof executeOptimize !== 'function' || typeof props.sessionId !== 'string') {
          setStatus('error');
          setNote(tr('error.notRegistered'));
          return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        setStatus('working');
        setNote('');
        try {
          const response = await executeOptimize(props.sessionId, text, controller.signal);
          if (!mountedRef.current) return;
          if (!response || response.ok !== true) {
            const detail = response && response.error
              ? String(response.error.message || response.error.code)
              : tr('error.generic');
            setStatus('error');
            setNote(detail);
            return;
          }
          const execution = response.value;
          if (execution === undefined) {
            setStatus('error');
            setNote(tr('error.notRegistered'));
            return;
          }
          const result = execution.result;
          const produced = result && result.kind === 'success' && typeof result.text === 'string' ? result.text.trim() : '';
          if (produced.length === 0) {
            setStatus('error');
            setNote(result && typeof result.text === 'string' && result.text.length > 0 ? result.text : tr('error.generic'));
            return;
          }
          try {
            props.inputActions.setDraft(produced);
          } catch (writeError) {
            setStatus('error');
            setNote(writeError instanceof Error ? writeError.message : tr('error.generic'));
            return;
          }
          setStatus('idle');
          setOptimizedFor(text);
        } catch (error) {
          if (!mountedRef.current || controller.signal.aborted) return;
          setStatus('error');
          setNote(error instanceof Error ? error.message : String(error));
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
        }
      };

      const label = busy ? tr('action.working') : done ? tr('action.done') : tr('action.optimize');

      return h('div', { className: 'po-dock' },
        h('style', { key: 'po-style' }, CSS),
        h('button', {
          key: 'po-button',
          type: 'button',
          className: 'po-btn',
          'data-state': done ? 'done' : 'idle',
          'aria-label': tr('action.aria'),
          'aria-busy': busy ? 'true' : undefined,
          disabled: busy || locked,
          title: tr('action.aria'),
          onClick: () => { void run(); },
        },
          busy
            ? h('span', { className: 'po-spin', 'aria-hidden': true })
            : h('span', { 'aria-hidden': true }, done ? '✓' : '✨'),
          h('span', null, label),
        ),
        note.length > 0
          ? h('span', {
            key: 'po-note',
            className: 'po-note',
            'data-tone': status === 'error' ? 'error' : 'info',
            role: status === 'error' ? 'alert' : undefined,
          }, note)
          : null,
      );
    }

    /**
     * `optimize-prompt` 命令在对话流里的行渲染器。
     *
     * 通用命令卡片会把整段优化结果铺在对话里，与已回填的输入框重复；
     * 这里收成一行摘要，并提供「填入输入框」按钮便于复用。
     *
     * @param {object} props - commandview slot props（node / inputActions / t）。
     * @returns {object | null} React 元素。
     */
    function OptimizeCommandRow(props) {
      const tr = translateOf(props);
      const node = props.node;
      if (!node || typeof node !== 'object') return null;

      const outcome = node.outcome && typeof node.outcome === 'object' ? node.outcome : null;
      const succeeded = outcome !== null
        && outcome.kind === 'success'
        && typeof outcome.text === 'string'
        && outcome.text.length > 0;

      let detail;
      let failed = false;
      if (succeeded) {
        detail = String(outcome.text.length) + tr('row.chars');
      } else if (outcome === null) {
        detail = tr('row.pending');
      } else if (outcome.kind === 'error') {
        failed = true;
        detail = tr('row.failed') + (typeof outcome.text === 'string' && outcome.text.length > 0 ? ' · ' + outcome.text : '');
      } else {
        detail = tr('row.pending');
      }

      const fill = () => {
        try {
          props.inputActions.setDraft(outcome.text);
        } catch {
          // 编辑器已锁定或会话已切换：静默忽略，不打断对话渲染。
        }
      };

      return h('div', { className: 'po-row' },
        h('style', { key: 'po-style' }, CSS),
        h('span', { key: 'po-row-title', className: 'po-row-title' }, '✨ ' + tr('row.title')),
        h('span', {
          key: 'po-row-detail',
          className: 'po-note',
          'data-tone': failed ? 'error' : 'info',
        }, detail),
        succeeded
          ? h('button', { key: 'po-row-fill', type: 'button', className: 'po-row-fill', onClick: fill }, tr('row.fill'))
          : null,
      );
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      /**
       * 客户端插件体：注册字典、输入框下方按钮、命令行渲染器。
       *
       * @param {object} ctx - 客户端上下文（已保证 slots/locale/remote.commands 存在）。
       * @returns {void}
       */
      apply(ctx) {
        const commands = ctx.remote.commands;
        executeOptimize = (sessionId, draft, signal) => commands.execute(
          sessionId,
          COMMAND_PREFIX + JSON.stringify({ draft }),
          [],
          signal,
        );

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-prompt-optimizer: dictionaries');

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'prompt-optimizer',
          order: 30,
          locale: NS,
        }, PromptOptimizerDock));

        ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview',
          key: COMMAND_NAME,
          locale: NS,
        }, OptimizeCommandRow));
      },
    };
  },
});
