/**
 * dsh-smartprompt — Host half.
 *
 * Registers the human slash command `/optimize-prompt`:
 * - The handler runs directly against the Agent, so no model message is created
 *   and `recordInput: false` keeps the draft out of `command/run`.
 * - It gathers project facts from caller-declared sources (documents under the
 *   session workspace, the git branch, the session goal) and asks the current
 *   model to rewrite the draft into a structured prompt.
 * - The result travels back as `CommandResult.text`, which the Client half fills
 *   into the composer.
 *
 * Why a command rather than a custom RPC: DSH's Client→Host channel is a
 * build-time generated set of Remote namespaces that a plain bundle cannot
 * extend; `ctx.commands` + `ctx.remote.commands.execute` is the supported entry
 * point for "a UI action calls a Host operation".
 *
 * @module dsh-smartprompt
 */

import { DEFAULTS, validateConfig } from './src/config.js';
import { optimizePrompt } from './src/optimize.js';

/** Plugin name; equals the package name the bundle patch inserts. */
export const name = 'dsh-smartprompt';

/** Hard dependencies: command registration plus model and file access. */
export const inject = ['commands', 'fs', 'llm'];

/** Command contract. The Client half builds lines from the same values. */
export const COMMAND = Object.freeze({
  name: 'optimize-prompt',
  description: 'Rewrite the composer draft into a structured prompt · 把输入框草稿改写为结构化提示词',
  hint: '<draft>',
});

export { DEFAULTS, validateConfig };

/**
 * Plugin entry point.
 *
 * @param {object} ctx - Cordis plugin context.
 * @param {unknown} config - The `config` of this row in `cordis.patch.yml`.
 * @returns {void}
 */
export function apply(ctx, config) {
  const cfg = validateConfig(config);
  if (cfg.enabled !== true) return;

  ctx.effect(
    () => ctx.commands.register({
      name: COMMAND.name,
      description: COMMAND.description,
      input: { hint: COMMAND.hint },
      recordInput: false,
      handler: (invocation) => optimizePrompt({ ctx, cfg, invocation }),
    }),
    'dsh-smartprompt: command',
  );
}
