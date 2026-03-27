# OpenCode integration

This fork is centered on an OpenCode use case: send real project context to GPT Pro through Oracle's browser path without having the handoff collapse under its own session history.

## Problem statement

The failure mode that motivated this repo is local and predictable.

- OpenCode's Oracle bridge assembled a large `opencode-session-context.md` file.
- Oracle enforced its local per-file attachment cap before the request ever reached ChatGPT.
- Long OpenCode sessions therefore became less reliable precisely when context mattered most.

The OpenCode work in this fork is about turning that brittle bridge into a stable interface.

## What ships here today

- `examples/opencode/oracle-agent.js`
  - a customized OpenCode Oracle bridge plugin
  - keeps recent context richer than older context
  - trims the forwarded transcript to a byte budget before attachment
- `examples/opencode/oracle-agent-memory.js`
  - deterministic structured extraction for session facts
  - local cache artifacts under `~/.oracle/opencode-memory/`
  - compact structured memory notes included in the forwarded context
  - heuristic query-aware retrieval over cached session artifacts
- `examples/opencode/oracle-config.json5`
  - a starter config snippet
  - raises `maxFileSizeBytes` to 4 MB
  - keeps the active ChatGPT model with `browser.modelStrategy: "current"`

These files are companion artifacts for a local OpenCode install. They are not yet integrated into the published Oracle package surface.
The source stays split in the repo, but the install step now bundles it into one deployed plugin file for OpenCode.

## Install

Sync the bridge files into your OpenCode config:

```bash
bun install
bun run opencode:sync
```

The sync step bundles `examples/opencode/oracle-agent.js` plus its local helper modules into a single deployed `~/.config/opencode/plugins/oracle-agent.js` file and removes the stale helper copy.

Then merge the relevant values from `examples/opencode/oracle-config.json5` into `~/.oracle/config.json`.

If you already have a config file, merge values rather than overwriting the whole file.

Restart OpenCode after copying the plugin.

## How the context budget works

The OpenCode bridge uses deterministic compaction.

1. Keep the newest session block in full when possible.
2. Render the next sessions in a compact form.
3. Render older sessions with a more aggressive summary form that removes bulky detail.
4. Drop the oldest session blocks entirely if the bundle is still over budget.
5. Add a deterministic structured session-memory layer for files, commands, errors, decisions, constraints, and open questions.
6. Retrieve older session artifacts into a separate section when they match the current query better than age alone would predict.

The goal is not to produce a beautiful retrospective. The goal is to keep the consult request valid and weighted toward the context most likely to matter for the current turn.

This is not LLM summarization. No extra model call is made to compress old history.
The structured memory section is also deterministic. It is extracted from the lineage and cached locally for later retrieval work.
The first retrieval pass is heuristic and query-aware. It ranks cached session artifacts by prompt overlap, file overlap, symbol overlap, decision overlap, and a small recency bonus.

## Why deterministic compaction first

This fork prefers deterministic pruning for the first line of defense because it is:

- local
- fast
- inspectable
- cheap
- free of recursive failure modes

An LLM summarization layer may still become useful later, but only as an explicit second stage rather than a hidden prerequisite for every consult.

## Tuning knobs

The bridge plugin supports these environment variables:

- `ORACLE_OPENCODE_MAX_CONTEXT_FILE_BYTES`
- `ORACLE_OPENCODE_MAX_RETRIEVED_MEMORY_BYTES`
- `ORACLE_OPENCODE_FULL_TRANSCRIPT_SESSIONS`
- `ORACLE_OPENCODE_COMPACT_TRANSCRIPT_SESSIONS`
- `ORACLE_OPENCODE_RETRIEVAL_PROTECTED_SESSIONS`
- `ORACLE_OPENCODE_MAX_TEXT_CHARS`
- `ORACLE_OPENCODE_MAX_TOOL_OUTPUT_CHARS`
- `ORACLE_OPENCODE_MAX_JSON_CHARS`

## Where this is headed

The current example-file approach is a staging point.

The intended direction is:

- first-class OpenCode installation instead of manual file copying
- better GPT Pro browser defaults out of the box
- a clearer contract between OpenCode session lineage and Oracle's attachment model
- fewer fork-local patches living only in a home directory

See `docs/roadmap.md` for the broader direction of the repo.
See `docs/query-aware-memory.md` for the planned next layer after deterministic compaction.
