/**
 * 项目事实采集与优化编排的单测：用假 fs / 假 llm / 假 ctx 覆盖降级与失败面。
 *
 * 运行：cd /home/ubuntu/dsh-prompt-optimizer && node --test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectProjectFacts, parseGitHead } from '../src/facts.js';
import { validateConfig } from '../src/config.js';
import { optimizePrompt, resolveModelRoute, streamCompletion } from '../src/optimize.js';

/** 极简假 fs：只认绝对路径表。 */
function fakeFs(files) {
  return {
    async resolve(path) {
      if (!(path in files)) throw new Error(`ENOENT ${path}`);
      return { path };
    },
    async readText(target) {
      if (!(target.path in files)) throw new Error(`ENOENT ${target.path}`);
      return files[target.path];
    },
  };
}

/** 假 ctx：按名字返回服务。 */
function fakeCtx(services) {
  return {
    get(name) {
      return services[name];
    },
    ...services,
  };
}

test('parseGitHead：分支名与游离头', () => {
  assert.equal(parseGitHead('ref: refs/heads/feature/login\n'), 'feature/login');
  assert.equal(parseGitHead('0123456789abcdef0123456789abcdef01234567'), 'detached 01234567');
  assert.equal(parseGitHead('garbage'), '');
});

test('collectProjectFacts：读分支与文档，并按预算截断', async () => {
  const fs = fakeFs({
    '/repo/.git/HEAD': 'ref: refs/heads/main\n',
    '/repo/AGENTS.md': 'A'.repeat(2000),
    '/repo/README.md': 'R'.repeat(100),
  });
  const facts = await collectProjectFacts({
    fs,
    cwd: '/repo',
    docs: ['AGENTS.md', 'README.md', 'MISSING.md'],
    budgetChars: 1200,
    includeGoal: true,
    goal: '  重构登录  ',
  });
  assert.equal(facts.cwd, '/repo');
  assert.equal(facts.branch, 'main');
  assert.equal(facts.goal, '重构登录');
  assert.equal(facts.documents.length, 2);
  assert.equal(facts.documents[0].path, 'AGENTS.md');
  assert.equal(facts.documents[0].truncated, true);
  assert.ok(facts.documents[0].text.length <= 600);
  assert.equal(facts.documents[1].path, 'README.md');
});

test('collectProjectFacts：无 cwd 或 fs 缺失时返回空事实而不是抛错', async () => {
  assert.deepEqual(await collectProjectFacts({ fs: undefined, cwd: undefined, docs: ['AGENTS.md'], budgetChars: 100 }), { documents: [] });
  assert.deepEqual(await collectProjectFacts({ fs: fakeFs({}), cwd: '/repo', docs: ['AGENTS.md'], budgetChars: 100 }), { cwd: '/repo', documents: [] });
});

test('collectProjectFacts：向上分层查找 .git/HEAD', async () => {
  const fs = fakeFs({
    '/repo/.git/HEAD': 'ref: refs/heads/dev\n',
    '/repo/backend/AGENTS.md': 'rules',
  });
  const facts = await collectProjectFacts({ fs, cwd: '/repo/backend', docs: ['AGENTS.md'], budgetChars: 500 });
  assert.equal(facts.branch, 'dev');
  assert.equal(facts.documents[0].text, 'rules');
});

test('resolveModelRoute：优先会话路由，退回默认选择', () => {
  const withAgent = fakeCtx({});
  assert.deepEqual(
    resolveModelRoute(withAgent, { options: { provider: 'deepseek', model: 'chat' } }),
    { provider: 'deepseek', model: 'chat' },
  );
  const withDefault = fakeCtx({ agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
  assert.deepEqual(resolveModelRoute(withDefault, { options: {} }), { provider: 'p', model: 'm' });
  assert.equal(resolveModelRoute(fakeCtx({}), { options: {} }), undefined);
});

test('streamCompletion：拼接 text-delta，捕获 finish 失败', async () => {
  const llm = {
    stream() {
      return (async function* chunks() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '你' };
        yield { type: 'text-delta', index: 0, text: '好' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const ok = await streamCompletion(llm, { provider: 'p', model: 'm', system: 's', user: 'u', maxTokens: 128, signal: new AbortController().signal });
  assert.equal(ok.text, '你好');
  assert.equal(ok.failure, undefined);

  const failing = {
    stream() {
      return (async function* chunks() {
        yield { type: 'text-delta', index: 0, text: '半' };
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'rate_limit', message: '限流' } } };
      })();
    },
  };
  const bad = await streamCompletion(failing, { provider: 'p', model: 'm', system: 's', user: 'u', maxTokens: 128, signal: new AbortController().signal });
  assert.equal(bad.failure.code, 'rate_limit');
});

test('optimizePrompt：无模型路由时返回可读错误', async () => {
  const ctx = fakeCtx({ llm: { stream: () => { throw new Error('should not be called'); } }, fs: fakeFs({}) });
  const cfg = validateConfig({});
  const result = await optimizePrompt({
    ctx,
    cfg,
    invocation: { rawInput: '{"draft":"加个验证码"}', agent: { options: {}, session: { header: { cwd: '/repo' } } } },
  });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /无法确定使用哪个模型/);
});

test('optimizePrompt：草稿超限直接拒绝，不调用模型', async () => {
  let called = false;
  const ctx = fakeCtx({
    llm: { stream: () => { called = true; return { [Symbol.asyncIterator]: null }; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  });
  const cfg = validateConfig({ maxDraftChars: 10 });
  const result = await optimizePrompt({
    ctx,
    cfg,
    invocation: { rawInput: '{"draft":"' + 'x'.repeat(50) + '"}', agent: { options: {}, session: { header: {} } } },
  });
  assert.equal(result.kind, 'error');
  // A Latin-only draft selects the English message locale.
  assert.match(result.text, /The draft is too long \(limit 10 characters\)/);
  assert.equal(called, false);
});

test('optimizePrompt：成功路径把模型输出清洗后回填', async () => {
  const ctx = fakeCtx({
    fs: fakeFs({ '/repo/.git/HEAD': 'ref: refs/heads/main\n', '/repo/AGENTS.md': '铁律：命令必须来自已验证清单' }),
    goals: { get: () => ({ objective: '做登录验证码' }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    llm: {
      stream() {
        return (async function* chunks() {
          yield { type: 'text-delta', index: 0, text: '```markdown\n## 目标\n给登录加图形验证码\n```' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
  });
  const cfg = validateConfig({ includeGoal: true });
  const result = await optimizePrompt({
    ctx,
    cfg,
    invocation: {
      rawInput: '{"draft":"给登录加验证码"}',
      agent: { options: { provider: 'p', model: 'm' }, session: { header: { cwd: '/repo' } } },
      signal: new AbortController().signal,
    },
  });
  assert.equal(result.kind, 'success');
  assert.equal(result.text, '## 目标\n给登录加图形验证码');
});

test('optimizePrompt: oversize CJK draft reports the Chinese message', async () => {
  let called = false;
  const ctx = fakeCtx({
    llm: { stream: () => { called = true; return { [Symbol.asyncIterator]: null }; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  });
  const cfg = validateConfig({ maxDraftChars: 10 });
  const result = await optimizePrompt({
    ctx,
    cfg,
    invocation: { rawInput: '{"draft":"给登录加一个图形验证码并加限流"}', agent: { options: {}, session: { header: {} } } },
  });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /草稿过长（上限 10 字）/);
  assert.equal(called, false);
});

test('optimizePrompt：模型抛错时收敛成错误结果而不是 reject', async () => {
  const ctx = fakeCtx({
    fs: fakeFs({}),
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    llm: {
      stream() {
        throw new Error('adapter exploded');
      },
    },
  });
  const cfg = validateConfig({});
  const result = await optimizePrompt({
    ctx,
    cfg,
    invocation: { rawInput: '{"draft":"做点事"}', agent: { options: {}, session: { header: {} } } },
  });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /模型调用失败：adapter exploded/);
});
