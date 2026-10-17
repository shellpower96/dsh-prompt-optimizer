# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-17

### Added

- Composer button in `conversation.composer.dock` that rewrites the draft into a structured prompt
  and fills the result back into the composer (`✨ Smart Prompt`, visible only while the draft is non-empty).
- Host command `optimize-prompt` (`recordInput: false`), which returns the optimized prompt as
  `CommandResult.text` and creates no model message.
- Project-fact collection from caller-declared sources: workspace-relative `docs`, the git branch read
  from `.git/HEAD` (no subprocess), and the optional session goal.
- Bilingual meta prompts (Chinese / English) selected from the draft's script, with
  `systemPromptLocale` to force one.
- Chinese and English UI copy through the Client locale service.
- Compact renderer for the command row in `conversation.chat.commandview` (one-line summary plus a
  "Fill composer" action) instead of the generic command card.
- `Config` validation at activation that fails loudly and names the offending field.
- Tests: public-API unit tests, no-project-context instantiation, and a caller-declared-context regression.
- Concise output budget: one config number (`maxOutputChars`, default 600 Chinese characters) with a
  locale-scaled ceiling (English 1.8x) and a native-unit target (450 字 / 141 words) plus a bullet
  discipline (3 per section, 10 total).
- Boundary-safe trimming: an over-long answer is cut at the last complete line, then a sentence end,
  then a word break, and only then hard-cut, ending in a single `…` instead of an English
  "(truncated; N characters total)" note inside the prompt body.

### Notes

- Verified against DSH `0.2.0-rc.2`. No `peerDependencies` are declared: DSH refuses to install a
  bundle whose peer range is incompatible, which is worse than a documented version note.
- The button renders only where a session exists, because the dock slot's scope is `session`.
