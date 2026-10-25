# Changelog

## 0.2.0 (2026-10-25)

- **opencode plugin** (`opencode/`): prunes the copy of the conversation sent with each request, through `experimental.chat.messages.transform`; the stored session is never touched. A cut is decided past the threshold and sent unchanged until the next one, so the prompt cache holds; it is saved and computed again identically after a restart. Drops the reasoning and images of finished turns, which opencode sends back with every request. On a real 190-request session: peak context 368k → 167k, cost $1.79 → $1.28.
- The core takes a tool profile (names, file keys, truncation markers) and characters per token, so it serves both hosts; Claude Code's behaviour is unchanged.
- `scripts/replay-opencode.ts` replays an `opencode export` request by request: context, cost with the real cache misses, and prefix stability between cuts.

## 0.1.0 (2026-09-26)

First release.

- `session.compact` hook that prunes old tool output instead of summarizing: results trimmed to head + tail by age, obsolete reads replaced by a note, long inputs of old calls shortened, images and past thinking dropped with a note.
- Nothing you or Claude wrote is changed, and no tool call is removed.
- Results the model has not read yet (those of its latest response) are not trimmed; only one over 60k characters is capped.
- Rebuilt rows are regrouped into whole API messages, so parallel tool calls stay paired with their results, including results recorded before the response listed its last call (checked on 10,616 calls from 81 real sessions).
- A compaction Claude Code starts at its own limit, or `/compact`, prunes whenever that frees enough; only lopper's own request must also leave room under the threshold.
- Notes carry an invisible marker, so a note quoted in a file is never taken for one of lopper's own.
- Skill instructions, `@` attachments and pasted-media notes, which the transcript rows do not carry, are put back in place.
- Falls back to the built-in summary when pruning cannot free enough, or when `/compact` has instructions.
- `turn.complete` trigger at a configurable threshold; a compaction lopper asked for is skipped, not summarized, when pruning would not help.
- `/lopper` shows the latest compactions.
