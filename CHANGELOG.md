# Changelog

## 0.1.0 (2026-09-26)

First release.

- `session.compact` hook that prunes old tool output instead of summarizing: results trimmed to head + tail by age, obsolete reads replaced by a note, long inputs of old calls shortened, images and past thinking dropped with a note.
- Nothing you or Claude wrote is changed, and no tool call is removed.
- Results the model has not read yet (after its last message) are never trimmed.
- Rebuilt rows are regrouped into whole API messages, so parallel tool calls stay paired with their results.
- Skill instructions, `@` attachments and pasted-media notes, which the transcript rows do not carry, are put back in place.
- Falls back to the built-in summary when pruning cannot free enough, or when `/compact` has instructions.
- `turn.complete` trigger at a configurable threshold; a compaction lopper asked for is skipped, not summarized, when pruning would not help.
- `/lopper` shows the latest compactions.
