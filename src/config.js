/**
 * Plugin configuration: defaults plus hand-written validation.
 *
 * No schema library and no implicit sources: every value comes from the row's
 * `config`. Validation runs synchronously at activation, so a bad value fails
 * loudly instead of degrading into a plugin that "looks installed but does
 * nothing".
 *
 * @module dsh-smartprompt/config
 */

/** Defaults. Field semantics are documented in README.md. */
export const DEFAULTS = Object.freeze({
  /** Master switch; when false the Host half registers nothing. */
  enabled: true,
  /** Maximum accepted draft length, in characters. */
  maxDraftChars: 4000,
  /** Total character budget for the project-facts block. */
  contextChars: 8000,
  /**
   * Character cap for the optimized prompt written back to the composer, in
   * Chinese characters; the English ceiling scales to 1.8x. Concise by design:
   * the meta prompt targets 75% of this and the hard cap only trims a runaway
   * answer at a structural boundary.
   */
  maxOutputChars: 400,
  /** Per-call timeout, in milliseconds. */
  timeoutMs: 120000,
  /**
   * Workspace-relative documents read as project facts, in order.
   * `AGENTS.md` and `README.md` are cross-tool conventions, not project assumptions.
   */
  docs: ['AGENTS.md', 'README.md'],
  /** Whether the session's current goal is included in the facts block. */
  includeGoal: true,
  /**
   * Language of the meta prompt itself: `auto` follows the draft's script,
   * `zh`/`en` force one. The produced prompt always follows the draft language.
   */
  systemPromptLocale: 'auto',
});

/** Locales accepted by `systemPromptLocale`. */
const PROMPT_LOCALES = new Set(['auto', 'zh', 'en']);

/** Document paths must stay workspace-relative: no absolute paths, no `..` segments. */
const DOC_NAME_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Validate and merge a row config onto the defaults.
 *
 * @param {unknown} raw - The `config` value from the `cordis.patch.yml` row.
 * @returns {typeof DEFAULTS} The complete, frozen configuration.
 * @throws {TypeError} When a field is missing a valid value; the message names it.
 */
export function validateConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('dsh-smartprompt: config must be an object');
  }

  const cfg = { ...DEFAULTS, ...input };

  if (typeof cfg.enabled !== 'boolean') {
    throw new TypeError('dsh-smartprompt: config.enabled must be a boolean');
  }
  for (const key of ['maxDraftChars', 'contextChars', 'maxOutputChars', 'timeoutMs']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] <= 0) {
      throw new TypeError(`dsh-smartprompt: config.${key} must be a positive integer`);
    }
  }
  if (!Array.isArray(cfg.docs) || cfg.docs.some((doc) => typeof doc !== 'string' || !DOC_NAME_PATTERN.test(doc))) {
    throw new TypeError('dsh-smartprompt: config.docs must be an array of workspace-relative paths (no absolute paths)');
  }
  if (cfg.docs.some((doc) => doc.split('/').includes('..'))) {
    throw new TypeError('dsh-smartprompt: config.docs must not contain ".." segments');
  }
  if (typeof cfg.includeGoal !== 'boolean') {
    throw new TypeError('dsh-smartprompt: config.includeGoal must be a boolean');
  }
  if (typeof cfg.systemPromptLocale !== 'string' || !PROMPT_LOCALES.has(cfg.systemPromptLocale)) {
    throw new TypeError('dsh-smartprompt: config.systemPromptLocale must be one of "auto" | "zh" | "en"');
  }

  return Object.freeze({ ...cfg, docs: Object.freeze([...cfg.docs]) });
}
