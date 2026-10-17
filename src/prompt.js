/**
 * Prompt assembly: draft parsing, meta-prompt construction, and output cleanup.
 *
 * Pure functions only (no ctx, no I/O) so the behavior is unit-testable in
 * isolation and reusable outside DSH.
 *
 * @module dsh-prompt-optimizer/prompt
 */

import { DEFAULTS } from './config.js';

/** Ordered section titles used by the meta prompt, per meta-prompt locale. */
export const SECTION_ORDER = Object.freeze({
  zh: Object.freeze(['目标', '现状与落点', '约束与规范', '任务拆解', '验收标准']),
  en: Object.freeze(['Goal', 'Current state and landing spot', 'Constraints and conventions', 'Task breakdown', 'Acceptance criteria']),
});

/** User-facing labels for the rendered facts block, per meta-prompt locale. */
const FACT_LABELS = Object.freeze({
  zh: Object.freeze({ cwd: '工作目录', branch: 'Git 分支', goal: '会话当前目标', excerpt: '（节选）', separator: '：' }),
  en: Object.freeze({ cwd: 'Working directory', branch: 'Git branch', goal: 'Current session goal', excerpt: ' (excerpt)', separator: ': ' }),
});

/**
 * Character ceiling for the returned text, per meta-prompt locale.
 *
 * `maxOutputChars` is defined in Chinese characters; the same information needs
 * roughly 1.8x the characters in English, so the English ceiling scales. Keeping
 * one number in config avoids the previous zh/en unit mismatch that made English
 * output run far past the truncation point.
 *
 * @param {{ locale?: 'zh'|'en', maxOutputChars?: number }} input
 * @returns {number} Ceiling in characters (<=0 disables capping).
 */
export function outputCeiling({ locale = 'zh', maxOutputChars = DEFAULTS.maxOutputChars } = {}) {
  if (!(maxOutputChars > 0)) return 0;
  return locale === 'en' ? Math.round(maxOutputChars * 1.8) : maxOutputChars;
}

/**
 * Concise target written into the meta prompt: below the ceiling on purpose, so
 * the model stops on its own instead of being truncated.
 *
 * @param {{ locale?: 'zh'|'en', maxOutputChars?: number }} input
 * @returns {{ kind: 'chars'|'words', value: number }} Target in the locale's native unit.
 */
export function outputTarget({ locale = 'zh', maxOutputChars = DEFAULTS.maxOutputChars } = {}) {
  const chars = Math.max(120, Math.floor(maxOutputChars * 0.75));
  if (locale !== 'en') return { kind: 'chars', value: chars };
  // A Chinese-character's worth of information is about 3.2 English words.
  return { kind: 'words', value: Math.max(50, Math.round(chars / 3.2)) };
}

/** CJK test used to pick the meta-prompt language when the caller says `auto`. */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * Decide which meta-prompt locale to use.
 *
 * @param {string} draft - The user's draft.
 * @param {'auto'|'zh'|'en'} [forced] - Caller override; `auto` inspects the draft script.
 * @returns {'zh'|'en'} The meta-prompt locale (not necessarily the output language).
 */
export function selectPromptLocale(draft, forced = 'auto') {
  if (forced === 'zh' || forced === 'en') return forced;
  return typeof draft === 'string' && CJK_PATTERN.test(draft) ? 'zh' : 'en';
}

/**
 * Parse the command's raw input into the draft to optimize.
 *
 * Two accepted shapes:
 * - JSON `{"draft":"..."}`: what the Client button sends (safe for newlines and quotes).
 * - Bare text: what a person types as `/optimize-prompt make the login form safer`.
 *
 * @param {unknown} rawInput - `CommandInvocation.rawInput`, including separator whitespace.
 * @returns {{ draft: string } | { error: string }} The draft, or a stable error code.
 */
export function parseDraft(rawInput) {
  const raw = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (raw.length === 0) return { error: 'EMPTY_DRAFT' };

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.draft === 'string') {
        const draft = parsed.draft.trim();
        return draft.length === 0 ? { error: 'EMPTY_DRAFT' } : { draft };
      }
      return { error: 'EMPTY_DRAFT' };
    } catch {
      // Not JSON: treat the whole input as plain draft text.
    }
  }

  return { draft: raw };
}

/**
 * Build the Chinese meta prompt.
 *
 * @param {number} maxOutputChars - Output cap, used to derive the length rule.
 * @param {boolean} detailed - Whether the draft is already long enough to preserve.
 * @returns {string} System prompt text.
 */
function zhSystem(maxOutputChars, detailed) {
  return [
    '你是 DSH 编程助手输入框里的「智能提示词」优化器。你的唯一任务：把用户的一句草稿，改写成一份能让 AI 编程 Agent 高质量完成开发的提示词。',
    '',
    '硬性规则：',
    '1. 忠于原意：只做澄清、补全、结构化；不擅自扩大或缩小范围。必须由用户决定的地方写成「待确认：…」，绝不替用户拍板。',
    '2. 有据可依：涉及模块、文件、命令、规范、测试方式时，只使用【项目事实】里真实出现的内容；没有依据就写「需先定位」，不要编造路径、接口、命令或测试名。',
    detailed
      ? '3. 草稿已经比较详细：以保留用户结构与措辞为主，只补齐缺失项并整理分节，不要改写成另一件事。'
      : '3. 草稿很简短：需要把它扩展成可执行的任务描述，但扩展出来的每一句都要能由【项目事实】或草稿本身支撑。',
    `4. 结构：按「${SECTION_ORDER.zh.join(' / ')}」分节，使用 Markdown 标题与条列；没有内容的小节直接省略，不要凑字数。`,
    '5. 可执行：验收标准必须可验证（具体命令、可观察行为、具体文件/接口），避免「尽量」「适当」「优化一下」这类空泛表述。',
    '6. 语言：与用户草稿语言一致（默认简体中文），术语沿用项目里已有的叫法。',
    `7. 篇幅：正文不超过 ${outputTarget({ locale: 'zh', maxOutputChars }).value} 字；每节最多 3 条，总条数不超过 10 条。`,
    '   不写背景铺垫、不复述草稿原话、不重复同一约束；能删的词一律删掉。',
    '8. 只输出提示词正文：不要前言、不要解释你的思路、不要「以下是优化后的提示词」这类引导语、不要整段代码块围栏。',
  ].join('\n');
}

/**
 * Build the English meta prompt.
 *
 * @param {number} maxOutputChars - Output cap, used to derive the length rule.
 * @param {boolean} detailed - Whether the draft is already long enough to preserve.
 * @returns {string} System prompt text.
 */
function enSystem(maxOutputChars, detailed) {
  return [
    'You are the "Smart Prompt" optimizer attached to a DSH coding agent\'s composer. Your only job: turn a one-line draft into a prompt that lets a coding agent finish the work to a high standard.',
    '',
    'Hard rules:',
    '1. Stay faithful: clarify, complete, and structure only. Do not widen or narrow the scope. Anything the user must decide goes in as "TBD: …" — never decide it for them.',
    '2. Ground every claim: whether you name a module, file, command, convention, or test approach, use only what actually appears under [Project facts]. Without evidence, write "needs locating" instead of inventing paths, endpoints, commands, or test names.',
    detailed
      ? '3. The draft is already fairly detailed: preserve the user\'s structure and wording, fill only the gaps, and organize the sections. Do not rewrite it into a different task.'
      : '3. The draft is terse: expand it into an executable task description, but every added sentence must be supported by [Project facts] or by the draft itself.',
    `4. Structure: use the sections "${SECTION_ORDER.en.join(' / ')}" as Markdown headings and bullets. Omit empty sections; never pad.`,
    '5. Executable: acceptance criteria must be verifiable (a concrete command, an observable behavior, a concrete file or endpoint). Avoid vague wording such as "reasonable", "appropriate", or "optimize it a bit".',
    '6. Language: write the prompt in the draft\'s language (English for English drafts), and reuse the terminology the project already uses.',
    `7. Length: at most ${outputTarget({ locale: 'en', maxOutputChars }).value} words. At most 3 bullets per section and 10 bullets total.`,
    '   No background preamble, no restating the draft, no duplicated constraints; cut every word that can go.',
    '8. Output the prompt body only: no preamble, no explanation of your reasoning, no "Here is the optimized prompt:", no wrapping code fence.',
  ].join('\n');
}

/**
 * Build the meta prompt sent to the model.
 *
 * @param {object} input
 * @param {string} input.draft - The user's draft.
 * @param {string} input.facts - Already-rendered project facts (may be empty).
 * @param {'zh'|'en'} [input.locale] - Meta-prompt locale.
 * @param {number} [input.maxOutputChars] - Output cap, written into the length rule.
 * @returns {{ system: string, user: string }} Prompts ready for `ctx.llm.stream`.
 */
export function buildPrompts({ draft, facts, locale = 'zh', maxOutputChars = DEFAULTS.maxOutputChars }) {
  const detailed = typeof draft === 'string' && draft.length >= 400;
  const system = locale === 'en' ? enSystem(maxOutputChars, detailed) : zhSystem(maxOutputChars, detailed);
  const trimmedFacts = typeof facts === 'string' ? facts.trim() : '';

  const user = locale === 'en'
    ? [
      '[Draft]',
      draft,
      '',
      '[Project facts]',
      trimmedFacts.length === 0
        ? '(no project facts available: rely on the draft alone and mark anything project-specific as "needs locating")'
        : trimmedFacts,
    ].join('\n')
    : [
      '【用户草稿】',
      draft,
      '',
      '【项目事实】',
      trimmedFacts.length === 0
        ? '（无可读项目事实：请只依据草稿，并在需要项目细节处标注「需先定位」）'
        : trimmedFacts,
    ].join('\n');

  return { system, user };
}

/** Model preambles worth stripping (only when the first line is short and clearly meta). */
const PREAMBLE_PATTERN = /^(以下是|下面是|这是|优化后的|您好|好的|here is|here's|below is|the following is)[^\n]{0,60}[：:]\s*\n+/i;

/**
 * Clean the model output so it can be written straight back into the composer.
 *
 * Handles: whole-answer code fences, leading preamble lines, surrounding
 * whitespace, and length capping.
 *
 * @param {string} raw - Raw model text.
 * @param {number} [maxChars] - Output cap (<=0 disables capping).
 * @returns {string} The cleaned prompt; an empty string means the model gave nothing.
 */
export function finalizeOptimizedText(raw, maxChars = DEFAULTS.maxOutputChars) {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return '';

  // A preamble and a fence can nest; strip at most two layers in a stable order.
  for (let pass = 0; pass < 2; pass += 1) {
    let next = text.replace(PREAMBLE_PATTERN, '').trim();
    const fenced = next.match(/^```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n```$/);
    if (fenced !== null) next = fenced[1].trim();
    if (next === text) break;
    text = next;
  }
  if (text.length === 0) return '';

  if (maxChars > 0 && text.length > maxChars) text = cutAtBoundary(text, maxChars);

  return text;
}

/**
 * Trim to a structural boundary instead of slicing mid-sentence.
 *
 * Prefers the last complete line, then a sentence end, then a word break, and
 * only then a hard cut. The result is at most `maxChars + 1` characters (the
 * ellipsis) and never carries explanatory text into the prompt body.
 *
 * @param {string} text - Text longer than the cap.
 * @param {number} maxChars - Character cap.
 * @returns {string} Trimmed text ending in an ellipsis.
 */
function cutAtBoundary(text, maxChars) {
  const head = text.slice(0, maxChars);
  const floor = maxChars * 0.5;
  const boundaries = [
    head.lastIndexOf('\n'),
    Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
      head.lastIndexOf('. '), head.lastIndexOf('; '), head.lastIndexOf('；')),
    head.lastIndexOf(' '),
  ];
  const cut = boundaries.find((index) => index > floor);
  const base = cut === undefined ? head : head.slice(0, cut);
  return `${base.trimEnd()}…`;
}

/**
 * Render the project facts block (consumed by {@link buildPrompts}).
 *
 * @param {object} facts - Result of `collectProjectFacts`.
 * @param {'zh'|'en'} [locale] - Label locale; must match the meta-prompt locale.
 * @returns {string} Human-readable fact list; empty when nothing is known.
 */
export function renderFacts(facts, locale = 'zh') {
  if (facts === undefined || facts === null) return '';
  const labels = FACT_LABELS[locale === 'en' ? 'en' : 'zh'];
  const lines = [];

  const sep = labels.separator;
  if (typeof facts.cwd === 'string' && facts.cwd.length > 0) lines.push(`- ${labels.cwd}${sep}${facts.cwd}`);
  if (typeof facts.branch === 'string' && facts.branch.length > 0) lines.push(`- ${labels.branch}${sep}${facts.branch}`);
  if (typeof facts.goal === 'string' && facts.goal.length > 0) lines.push(`- ${labels.goal}${sep}${facts.goal}`);

  if (Array.isArray(facts.documents)) {
    for (const doc of facts.documents) {
      if (doc === null || typeof doc !== 'object' || typeof doc.text !== 'string' || doc.text.length === 0) continue;
      lines.push('', `## ${doc.path}${doc.truncated === true ? labels.excerpt : ''}`, doc.text.trim());
    }
  }

  return lines.join('\n');
}
