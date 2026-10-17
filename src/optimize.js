/**
 * The single implementation of the optimize action.
 *
 * This is the "one operation" side of the plugin: the Client button reaches it
 * through the `/optimize-prompt` command, and any future agent tool must call
 * `optimizePrompt()` rather than reimplementing the flow.
 *
 * @module dsh-smartprompt/optimize
 */

import { collectProjectFacts } from './facts.js';
import {
  buildPrompts,
  finalizeOptimizedText,
  outputCeiling,
  parseDraft,
  renderFacts,
  selectPromptLocale,
} from './prompt.js';

/** User-facing failure copy. English by default; a draft in CJK gets the Chinese variant. */
const MESSAGES = Object.freeze({
  en: Object.freeze({
    EMPTY_DRAFT: 'Type the content to optimize in the composer first.',
    NO_MODEL: 'No model route is available: this session has no selected model and no default model is configured. Select a model, then retry.',
    TIMEOUT: 'Optimization timed out (the model did not answer in time). Try a narrower draft and retry.',
    ABORTED: 'Cancelled.',
    EMPTY_RESULT: 'The model returned nothing usable. Retry, or make the draft more specific.',
    DRAFT_TOO_LONG: 'The draft is too long (limit {max} characters). Shorten it or optimize it in parts.',
    PREFIX: 'Model call failed: ',
  }),
  zh: Object.freeze({
    EMPTY_DRAFT: '请先在输入框里写下要优化的内容。',
    NO_MODEL: '无法确定使用哪个模型：会话未选择模型，也没有默认模型配置。请在模型设置里选择一个模型后重试。',
    TIMEOUT: '优化超时（模型长时间无响应）。可以缩小草稿范围后重试。',
    ABORTED: '已取消。',
    EMPTY_RESULT: '模型没有返回可用内容，请重试或把草稿写得具体一些。',
    DRAFT_TOO_LONG: '草稿过长（上限 {max} 字）。请先精简，或分几次优化。',
    PREFIX: '模型调用失败：',
  }),
});

/**
 * Read a message for one locale.
 *
 * @param {'zh'|'en'} locale - Message locale.
 * @param {keyof typeof MESSAGES.en} key - Message key.
 * @returns {string} The localized message.
 */
function message(locale, key) {
  return MESSAGES[locale === 'en' ? 'en' : 'zh'][key];
}

/**
 * Read an optional Host service, tolerant of both context flavors.
 *
 * @param {object} ctx - The plugin context.
 * @param {string} name - Service name.
 * @returns {any | undefined} The service, or undefined when unavailable.
 */
function optionalService(ctx, name) {
  let value;
  try {
    if (typeof ctx.get === 'function') value = ctx.get(name);
  } catch {
    // Restricted contexts may refuse `get`; property access below covers it.
  }
  if (value !== undefined) return value;
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}

/**
 * Resolve the provider/model route for this call.
 *
 * The session Agent's own route wins (it reflects a per-session model choice);
 * the process default model selection is the fallback.
 *
 * @param {object} ctx - The plugin context.
 * @param {{ options?: { provider?: string, model?: string } }} agent - The receiving Agent.
 * @returns {{ provider: string, model: string } | undefined} The route, or undefined.
 */
export function resolveModelRoute(ctx, agent) {
  const fromAgent = agent?.options;
  if (typeof fromAgent?.provider === 'string' && fromAgent.provider.length > 0
    && typeof fromAgent?.model === 'string' && fromAgent.model.length > 0) {
    return { provider: fromAgent.provider, model: fromAgent.model };
  }
  const selection = optionalService(ctx, 'agentDefaultModel')?.currentSelection?.();
  if (typeof selection?.provider === 'string' && selection.provider.length > 0
    && typeof selection?.model === 'string' && selection.model.length > 0) {
    return { provider: selection.provider, model: selection.model };
  }
  return undefined;
}

/**
 * Combine caller cancellation with a local deadline.
 *
 * @param {AbortSignal | undefined} signal - The caller's signal.
 * @param {number} timeoutMs - Deadline in milliseconds.
 * @returns {{ signal: AbortSignal, dispose: () => void, outcome: () => 'none' | 'timeout' | 'caller' }} The combined signal.
 */
function combineDeadline(signal, timeoutMs) {
  const controller = new AbortController();
  let outcome = 'none';

  const onCallerAbort = () => {
    outcome = 'caller';
    controller.abort(signal?.reason);
  };

  if (signal !== undefined && signal !== null) {
    if (signal.aborted === true) onCallerAbort();
    else signal.addEventListener?.('abort', onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    if (outcome === 'none') outcome = 'timeout';
    controller.abort(new Error('dsh-smartprompt: timed out'));
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    outcome: () => outcome,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onCallerAbort);
    },
  };
}

/**
 * Stream one completion and collect its plain text.
 *
 * @param {object} llm - `ctx.llm`.
 * @param {object} request - Call parameters.
 * @param {string} request.provider - Provider route.
 * @param {string} request.model - Model id.
 * @param {string} request.system - System prompt.
 * @param {string} request.user - User prompt.
 * @param {number} request.maxTokens - Output token cap.
 * @param {AbortSignal} request.signal - Combined cancellation signal.
 * @returns {Promise<{ text: string, failure?: { code: string, message: string } }>} Text plus optional failure.
 */
export async function streamCompletion(llm, { provider, model, system, user, maxTokens, signal }) {
  const chunks = llm.stream({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens,
    signal,
  });

  let text = '';
  let failure;
  for await (const chunk of chunks) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      continue;
    }
    if (chunk?.type === 'finish') {
      const kind = chunk.reason?.kind;
      if (kind === 'error' || kind === 'aborted') {
        failure = {
          code: typeof chunk.reason?.failure?.code === 'string' ? chunk.reason.failure.code : 'model-error',
          message: typeof chunk.reason?.failure?.message === 'string' ? chunk.reason.failure.message : 'model error',
        };
      }
    }
  }

  return { text, failure };
}

/**
 * Run one prompt optimization.
 *
 * @param {object} input
 * @param {object} input.ctx - Plugin context (uses fs/llm/agentDefaultModel/goals when present).
 * @param {ReturnType<import('./config.js').validateConfig>} input.cfg - Validated config.
 * @param {{ rawInput: string, agent: object, signal?: AbortSignal }} input.invocation - The command invocation.
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} The command result.
 */
export async function optimizePrompt({ ctx, cfg, invocation }) {
  const parsed = parseDraft(invocation?.rawInput);
  if ('error' in parsed) {
    return { kind: 'error', text: message('zh', parsed.error) };
  }

  const draft = parsed.draft;
  const locale = selectPromptLocale(draft, cfg.systemPromptLocale);

  if (draft.length > cfg.maxDraftChars) {
    return { kind: 'error', text: message(locale, 'DRAFT_TOO_LONG').replace('{max}', String(cfg.maxDraftChars)) };
  }

  const agent = invocation?.agent;
  const route = resolveModelRoute(ctx, agent);
  if (route === undefined) return { kind: 'error', text: message(locale, 'NO_MODEL') };

  const cwd = agent?.session?.header?.cwd;
  const goalView = cfg.includeGoal === true ? optionalService(ctx, 'goals')?.get?.(agent) : undefined;
  const facts = await collectProjectFacts({
    fs: optionalService(ctx, 'fs'),
    cwd,
    docs: cfg.docs,
    budgetChars: cfg.contextChars,
    includeGoal: cfg.includeGoal,
    goal: typeof goalView?.objective === 'string' ? goalView.objective : undefined,
    signal: invocation?.signal,
  });

  const { system, user } = buildPrompts({
    draft,
    facts: renderFacts(facts, locale),
    locale,
    maxOutputChars: cfg.maxOutputChars,
  });
  const deadline = combineDeadline(invocation?.signal, cfg.timeoutMs);
  // Token budget follows the character ceiling: ~1 token per character is enough
  // for CJK and generous for English, so the model stops before the hard cap.
  const ceiling = outputCeiling({ locale, maxOutputChars: cfg.maxOutputChars });
  const maxTokens = Math.min(1024, Math.max(256, Math.ceil(ceiling / 1.2)));

  try {
    const { text, failure } = await streamCompletion(ctx.llm, {
      provider: route.provider,
      model: route.model,
      system,
      user,
      maxTokens,
      signal: deadline.signal,
    });

    if (failure !== undefined) {
      if (deadline.outcome() === 'timeout') return { kind: 'error', text: message(locale, 'TIMEOUT') };
      if (deadline.outcome() === 'caller') return { kind: 'error', text: message(locale, 'ABORTED') };
      return { kind: 'error', text: `${message(locale, 'PREFIX')}${failure.message}` };
    }

    const optimized = finalizeOptimizedText(text, ceiling);
    if (optimized.length === 0) return { kind: 'error', text: message(locale, 'EMPTY_RESULT') };
    return { kind: 'success', text: optimized };
  } catch (error) {
    if (deadline.outcome() === 'timeout') return { kind: 'error', text: message(locale, 'TIMEOUT') };
    if (deadline.outcome() === 'caller' || error?.name === 'AbortError') {
      return { kind: 'error', text: message(locale, 'ABORTED') };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: 'error', text: `${message(locale, 'PREFIX')}${detail}` };
  } finally {
    deadline.dispose();
  }
}
