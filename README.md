# dsh-prompt-optimizer

A [DSH](https://github.com/deepseek-ai/deepseek-harness) Web plugin that adds a **Smart Prompt** button
under the composer. Click it and your rough draft is rewritten into a structured, executable prompt
grounded in your workspace conventions — then filled straight back into the composer.

```
┌─ composer (draft: "make the login form safer") ─┐
└─────────────────────────────────────────────────┘
  ✨ Smart Prompt          ← appears only while the draft is non-empty
```

- Empty draft → the button is not rendered.
- Click → the button shows *Optimizing…*, the result replaces the draft, the button turns into *✓ Optimized*.
- Failure → one line of explanation next to the button (timeout / no model / model error); the draft is untouched.
- Each click leaves one `command/run` + `command/done` pair in the session log (that is how DSH's command
  channel works). The plugin renders that as a single-line summary in the conversation
  (*✨ Smart Prompt · N chars · Fill composer*), never as the whole prompt.

中文摘要见文末。

## Install

DSH's plugin catalog is the package manager itself — there is no separate submission portal.
Install this bundle from its git repository:

```text
plugin_manager(action="install_bundle", target="github:shellpower96/dsh-prompt-optimizer#v0.1.0")
```

...or from a local checkout while developing:

```text
plugin_manager(action="install_bundle", target="/absolute/path/to/dsh-prompt-optimizer")
```

Installing needs `pnpm` on `PATH` (the plugin manager runs `pnpm add`); without it you get
`spawn pnpm ENOENT`. Remove with:

```text
plugin_manager(action="remove_bundle", target="dsh-prompt-optimizer")
```

The Host half registers the command; the Client half ships as a browser module via
`dsh.client`. Installing a new bundle can arrive over HMR — if the button does not appear,
refresh the page once.

## Minimal example

An empty config is enough:

```yaml
- insert:
    - id: prompt-optimizer
      name: 'dsh-prompt-optimizer'
      config: {}
```

To point it at your own conventions (this is the only integration surface — the plugin assumes
no project layout):

```yaml
- insert:
    - id: prompt-optimizer
      name: 'dsh-prompt-optimizer'
      config:
        docs: ['AGENTS.md', 'README.md', 'docs/architecture.md']
        contextChars: 6000
        systemPromptLocale: auto
```

## Configuration

Every value is read from the row's `config`; the plugin reads no environment variables and no
settings module of its own. Invalid values throw at activation with the field name.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` registers nothing |
| `maxDraftChars` | `4000` | Reject longer drafts instead of sending them to the model |
| `contextChars` | `8000` | Total character budget for the project-facts block |
| `maxOutputChars` | `400` | Character cap for the optimized prompt, defined in Chinese characters; the English ceiling scales to 1.8x. The meta prompt targets 75% of it, so the hard cap only trims a runaway answer |
| `timeoutMs` | `120000` | Per-call timeout |
| `docs` | `["AGENTS.md","README.md"]` | Workspace-relative documents read as facts, in order; missing files are skipped, absolute paths and `..` are rejected |
| `includeGoal` | `true` | Include the session's current goal in the facts block |
| `systemPromptLocale` | `"auto"` | Language of the meta prompt: `auto` follows the draft's script, `zh`/`en` force one. The produced prompt always follows the draft's language |

## How the prompt is produced

The meta prompt pins five properties (`src/prompt.js`):

1. **Faithful** — clarify, complete, structure; never widen or narrow scope. User decisions become `TBD: …`.
2. **Grounded** — modules, files, commands, conventions and test approaches may only be named if they
   actually appear in the facts block; otherwise the model writes *needs locating* instead of inventing them.
3. **Structured** — Goal / Current state and landing spot / Constraints and conventions / Task breakdown /
   Acceptance criteria; empty sections are dropped.
4. **Executable** — acceptance criteria must be verifiable (a command, an observable behavior, a concrete file).
5. **Concise** — one length budget per locale, expressed in that locale's native unit (Chinese characters /
   English words), plus a bullet discipline: at most 3 bullets per section and 10 in total, no background
   preamble, no restating the draft, no duplicated constraints.
6. **Body only** — no preamble, no reasoning, no code fence; `finalizeOptimizedText()` strips a fence or
   preamble the model adds anyway.

### Length budget

With the default `maxOutputChars: 400`:

| Locale | Target written into the meta prompt | Hard ceiling on the result | Token budget |
|---|---|---|---|
| zh | 300 字 | 400 characters | 334 |
| en | 94 words | 720 characters | 600 |

The target sits below the ceiling on purpose, so a compliant answer is never truncated. If a model
overruns anyway, `finalizeOptimizedText()` cuts at the last complete line (falling back to a sentence
end, then a word break, then a hard cut) and appends a single `…` — it never slices mid-sentence and
never writes explanatory text into the prompt body.

## Layout

| File | Role |
|---|---|
| `index.js` | Host entry: validate config, register `/optimize-prompt` |
| `src/config.js` | Defaults + hand-written validation (fails loudly) |
| `src/facts.js` | Fact collection: read-only, bounded, never throws; branch comes from `.git/HEAD`, no subprocess |
| `src/prompt.js` | Pure: draft parsing, meta-prompt assembly (zh/en), output cleanup |
| `src/optimize.js` | Orchestration: parse → collect → resolve model route → stream → clean |
| `client.js` | Browser half: composer button, command-row renderer, copy |

Model route: the session Agent's own `provider`/`model` wins, then the process default model
selection (`ctx.agentDefaultModel`). The call goes through `ctx.llm.stream()`, so `llm/stream`
middleware still applies.

## Tests

```bash
node --test
```

Three groups: public-API unit tests, **no-project-context instantiation** (no `fs`, no `cwd`,
no `goals`, no default model — assertions are "explicit outcome, never an uncaught throw"), and a
project-context regression that drives the plugin with a caller-declared `docs` list.

## Known limits

- **Only renders once a session exists.** The button lives in `conversation.composer.dock`
  (scope `session`), so a brand-new conversation's first screen has no button; it appears after the
  first message.
- **The command name is fixed** (`optimize-prompt`): both halves build the command line from a
  shared constant, and DSH rejects two registrations of the same name in one scope. Renaming it
  means editing `index.js` and `client.js` together.
- **Not a tool**: the plugin changes no system prompt and adds no agent tool.
- **Length is a soft promise plus one hard cut**: models are asked to stay inside the budget; the cap is
  only a guard rail. Raising `maxOutputChars` raises both the target and the ceiling. Every default in
  `src/prompt.js` derives from this one config value, so they cannot drift apart.
- Verified against **DSH 0.2.0-rc.2**. No `peerDependencies` are declared on purpose: DSH blocks
  installation on an incompatible peer, which would be worse than a documented version note.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文摘要

在 DSH Web 输入框下方加一个「✨ 智能提示词」按钮：有草稿时才出现，点击后结合**会话工作目录里
你自己声明的项目文档**（默认 `AGENTS.md` / `README.md`）、git 分支与会话目标，把草稿改写成
「目标 / 现状与落点 / 约束与规范 / 任务拆解 / 验收标准」五段式提示词并回填输入框。

配置全部由调用方注入，插件不读任何环境变量或项目设置；校验失败在激活时直接抛错。
安装：`plugin_manager install_bundle` 指向本仓的 git 地址。已知边界：全新会话（还没有 session）
时按钮不出现；命令名 `optimize-prompt` 不可配。
