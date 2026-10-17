/**
 * Public-API unit tests: configuration validation, draft parsing, language
 * selection, meta-prompt assembly, and output cleanup.
 *
 * Run: `node --test`
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS, validateConfig } from '../src/config.js';
import {
  buildPrompts,
  finalizeOptimizedText,
  outputCeiling,
  outputTarget,
  parseDraft,
  renderFacts,
  selectPromptLocale,
} from '../src/prompt.js';

test('validateConfig: empty config merges the defaults', () => {
  const cfg = validateConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.maxDraftChars, DEFAULTS.maxDraftChars);
  assert.equal(cfg.systemPromptLocale, 'auto');
  assert.deepEqual([...cfg.docs], ['AGENTS.md', 'README.md']);
});

test('validateConfig: invalid fields fail loudly with the field name', () => {
  assert.throws(() => validateConfig({ maxDraftChars: 0 }), /maxDraftChars/);
  assert.throws(() => validateConfig({ timeoutMs: 1.5 }), /timeoutMs/);
  assert.throws(() => validateConfig({ docs: ['../secret.md'] }), /docs/);
  assert.throws(() => validateConfig({ docs: ['/etc/passwd'] }), /docs/);
  assert.throws(() => validateConfig({ enabled: 'yes' }), /enabled/);
  assert.throws(() => validateConfig({ systemPromptLocale: 'fr' }), /systemPromptLocale/);
  assert.throws(() => validateConfig([]), /must be an object/);
});

test('parseDraft: JSON form carries newlines and quotes', () => {
  const draft = 'first line\nsecond "quoted" line';
  assert.deepEqual(parseDraft(`  ${JSON.stringify({ draft })}  `), { draft });
});

test('parseDraft: bare text is the draft', () => {
  assert.deepEqual(parseDraft('  make the login form safer  '), { draft: 'make the login form safer' });
  assert.deepEqual(parseDraft('{not json at all'), { draft: '{not json at all' });
});

test('parseDraft: empty input reports a stable code', () => {
  assert.deepEqual(parseDraft('   '), { error: 'EMPTY_DRAFT' });
  assert.deepEqual(parseDraft('{"draft":"   "}'), { error: 'EMPTY_DRAFT' });
  assert.deepEqual(parseDraft(undefined), { error: 'EMPTY_DRAFT' });
});

test('selectPromptLocale: auto follows the draft script, forced wins', () => {
  assert.equal(selectPromptLocale('给登录加验证码', 'auto'), 'zh');
  assert.equal(selectPromptLocale('make the login form safer', 'auto'), 'en');
  assert.equal(selectPromptLocale('make the login form safer', 'zh'), 'zh');
  assert.equal(selectPromptLocale('给登录加验证码', 'en'), 'en');
});

test('buildPrompts: Chinese draft gets the Chinese meta prompt', () => {
  const draft = '给登录加验证码';
  const locale = selectPromptLocale(draft, 'auto');
  const { system, user } = buildPrompts({ draft, facts: '- Git 分支：main', locale });
  assert.match(system, /智能提示词/);
  assert.match(system, /目标 \/ 现状与落点/);
  assert.match(user, /【用户草稿】/);
  assert.match(user, /Git 分支：main/);
});

test('buildPrompts: English draft gets the English meta prompt', () => {
  const draft = 'make the login form safer';
  const locale = selectPromptLocale(draft, 'auto');
  const { system, user } = buildPrompts({ draft, facts: '- Git branch: main', locale });
  assert.match(system, /Smart Prompt/);
  assert.match(system, /Goal \/ Current state and landing spot/);
  assert.match(user, /\[Draft\]/);
  assert.match(user, /Git branch: main/);
});

test('buildPrompts: forced=en with a CJK draft still yields the English meta prompt', () => {
  const draft = '给登录加验证码';
  const locale = selectPromptLocale(draft, 'en');
  const { system } = buildPrompts({ draft, facts: '', locale });
  assert.match(system, /You are the "Smart Prompt" optimizer/);
  assert.doesNotMatch(system, /智能提示词/);
});

test('buildPrompts: missing facts ask the model to mark unknowns', () => {
  const zh = buildPrompts({ draft: '加个接口', facts: '', locale: 'zh' });
  assert.match(zh.user, /需先定位/);
  const en = buildPrompts({ draft: 'add an endpoint', facts: '', locale: 'en' });
  assert.match(en.user, /needs locating/);
});

test('renderFacts: zh and en labels are mutually exclusive', () => {
  const facts = {
    cwd: '/repo',
    branch: 'main',
    goal: 'refactor login',
    documents: [{ path: 'AGENTS.md', text: 'rule 1', truncated: true }],
  };

  const zh = renderFacts(facts, 'zh');
  assert.match(zh, /工作目录：\/repo/);
  assert.match(zh, /Git 分支：main/);
  assert.match(zh, /会话当前目标：refactor login/);
  assert.match(zh, /## AGENTS\.md（节选）/);
  assert.doesNotMatch(zh, /Working directory/);

  const en = renderFacts(facts, 'en');
  assert.match(en, /Working directory: \/repo/);
  assert.match(en, /Git branch: main/);
  assert.match(en, /Current session goal: refactor login/);
  assert.match(en, /## AGENTS\.md \(excerpt\)/);
  assert.doesNotMatch(en, /工作目录/);

  assert.equal(renderFacts(undefined, 'en'), '');
});

test('finalizeOptimizedText: strips a fence and a preamble', () => {
  const raw = 'Here is the optimized prompt:\n\n```markdown\n## Goal\nadd a captcha\n```\n';
  assert.equal(finalizeOptimizedText(raw, 1000), '## Goal\nadd a captcha');
});

test('finalizeOptimizedText: keeps a normal first heading', () => {
  const raw = '## Goal\nadd a captcha to the login form';
  assert.equal(finalizeOptimizedText(raw, 1000), raw);
});

test('finalizeOptimizedText: a single over-long line is hard-cut and marked', () => {
  const out = finalizeOptimizedText('y'.repeat(200), 50);
  assert.equal(out, `${'y'.repeat(50)}…`);
  assert.ok(out.length <= 51);
});

test('finalizeOptimizedText: trims at the last complete line, not mid-sentence', () => {
  const text = '## 目标\n加图形验证码\n## 约束\n' + '细节'.repeat(60);
  const out = finalizeOptimizedText(text, 60);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 61);
  // The cut lands on a line boundary, so the kept prefix is whole lines.
  assert.match(out, /^## 目标\n加图形验证码\n/);
  assert.doesNotMatch(out, /truncated/);
});

test('finalizeOptimizedText: never writes explanatory text into the prompt body', () => {
  const out = finalizeOptimizedText('x'.repeat(300), 40);
  assert.doesNotMatch(out, /truncated|characters total/);
});

test('outputCeiling: one config number, locale-scaled characters', () => {
  assert.equal(outputCeiling({ locale: 'zh', maxOutputChars: 600 }), 600);
  assert.equal(outputCeiling({ locale: 'en', maxOutputChars: 600 }), 1080);
  assert.equal(outputCeiling({ locale: 'zh', maxOutputChars: 0 }), 0);
  // Disabled capping.
  assert.equal(outputCeiling({ locale: 'en', maxOutputChars: 0 }), 0);
});

test('outputTarget: native unit per locale, comfortably under the ceiling', () => {
  assert.deepEqual(outputTarget({ locale: 'zh', maxOutputChars: 600 }), { kind: 'chars', value: 450 });
  assert.deepEqual(outputTarget({ locale: 'en', maxOutputChars: 600 }), { kind: 'words', value: 141 });
  // The target must stay below the ceiling so the hard cut is a last resort.
  assert.ok(outputTarget({ locale: 'zh', maxOutputChars: 600 }).value < outputCeiling({ locale: 'zh', maxOutputChars: 600 }));
});

test('buildPrompts: Chinese length rule states the budget and the bullet discipline', () => {
  const { system } = buildPrompts({ draft: '给登录加验证码', facts: '', locale: 'zh', maxOutputChars: 600 });
  assert.match(system, /正文不超过 450 字/);
  assert.match(system, /每节最多 3 条，总条数不超过 10 条/);
  assert.match(system, /不写背景铺垫/);
});

test('buildPrompts: English length rule states the budget and the bullet discipline', () => {
  const { system } = buildPrompts({ draft: 'add a captcha', facts: '', locale: 'en', maxOutputChars: 600 });
  assert.match(system, /at most 141 words/);
  assert.match(system, /At most 3 bullets per section and 10 bullets total/);
  assert.match(system, /No background preamble/);
});

test('finalizeOptimizedText: empty output stays empty', () => {
  assert.equal(finalizeOptimizedText('   ', 100), '');
  assert.equal(finalizeOptimizedText('```\n\n```', 100), '');
});
