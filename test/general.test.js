/**
 * No-project-context instantiation tests.
 *
 * These assert the plugin is usable on a machine that has no project at all:
 * no file service, no workspace cwd, no goal service, and no default model.
 * The contract is "an explicit outcome, never an uncaught throw".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, COMMAND, inject, name } from '../index.js';
import { validateConfig } from '../src/config.js';

/** Build the smallest context that can host `apply()` and yield the registered command. */
function bareContext(services = {}) {
  const state = { registered: undefined, disposed: 0 };
  const ctx = {
    // No `get` at all: property access is the only channel here.
    effect: (factory) => {
      const dispose = factory();
      return () => {
        state.disposed += 1;
        if (typeof dispose === 'function') dispose();
      };
    },
    commands: {
      register: (definition) => {
        state.registered = definition;
        return () => {};
      },
    },
    ...services,
  };
  return { ctx, state };
}

/** A model that always answers with one fixed text. */
function fixedLlm(text) {
  const calls = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* chunks() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

test('manifest constants are stable', () => {
  assert.equal(name, 'dsh-smartprompt');
  assert.deepEqual(inject, ['commands', 'fs', 'llm']);
  assert.equal(COMMAND.name, 'optimize-prompt');
});

test('apply() registers exactly one command and is inert when disabled', () => {
  const enabled = bareContext();
  apply(enabled.ctx, {});
  assert.equal(enabled.state.registered.name, 'optimize-prompt');
  assert.equal(enabled.state.registered.recordInput, false);

  const disabled = bareContext();
  apply(disabled.ctx, { enabled: false });
  assert.equal(disabled.state.registered, undefined);
});

test('apply() rejects an invalid config at activation', () => {
  const { ctx } = bareContext();
  assert.throws(() => apply(ctx, { maxDraftChars: -1 }), /maxDraftChars/);
  assert.throws(() => apply(ctx, { systemPromptLocale: 'klingon' }), /systemPromptLocale/);
});

test('no project context and no model: readable error, nothing thrown', async () => {
  const { ctx, state } = bareContext({ llm: fixedLlm('unused') });
  apply(ctx, {});
  const result = await state.registered.handler({
    rawInput: 'make the login form safer',
    agent: { options: {}, session: { header: {} } },
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /No model route is available/);
});

test('no project context but a session model: degrades to draft-only facts', async () => {
  const llm = fixedLlm('## Goal\nmake the login form safer');
  const { ctx, state } = bareContext({ llm });
  apply(ctx, {});

  const result = await state.registered.handler({
    rawInput: '{"draft":"make the login form safer"}',
    agent: { options: { provider: 'p', model: 'm' }, session: { header: {} } },
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, 'success');
  assert.equal(result.text, '## Goal\nmake the login form safer');
  assert.equal(llm.calls.length, 1);

  const { system, messages } = llm.calls[0];
  // English draft → English meta prompt, and the user message says facts were unavailable.
  assert.match(system, /You are the "Smart Prompt" optimizer/);
  assert.match(messages[0].content[0].text, /\[Project facts\]\n\(no project facts available/);
});

test('an unreadable document is skipped instead of failing the call', async () => {
  const llm = fixedLlm('## Goal\nship it');
  const fs = {
    async resolve() {
      throw new Error('ENOENT');
    },
    async readText() {
      throw new Error('ENOENT');
    },
  };
  const { ctx, state } = bareContext({ llm, fs });
  apply(ctx, { docs: ['AGENTS.md'] });

  const result = await state.registered.handler({
    rawInput: '{"draft":"ship it"}',
    agent: { options: { provider: 'p', model: 'm' }, session: { header: { cwd: '/nowhere' } } },
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, 'success');
  assert.match(llm.calls[0].messages[0].content[0].text, /Working directory: \/nowhere/);
});

test('an empty draft is rejected before any model call', async () => {
  const llm = fixedLlm('unused');
  const { ctx, state } = bareContext({ llm });
  apply(ctx, {});
  const result = await state.registered.handler({
    rawInput: '   ',
    agent: { options: { provider: 'p', model: 'm' } },
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, 'error');
  assert.equal(llm.calls.length, 0);
});

test('config defaults are the documented ones', () => {
  const cfg = validateConfig({});
  assert.deepEqual({ ...cfg }, {
    enabled: true,
    maxDraftChars: 4000,
    contextChars: 8000,
    maxOutputChars: 400,
    timeoutMs: 120000,
    docs: ['AGENTS.md', 'README.md'],
    includeGoal: true,
    systemPromptLocale: 'auto',
  });
});
