# OpenCode integration notes

This fork stores the OpenCode-side customization used to keep Oracle consult requests under the local attachment cap when the forwarded `opencode-session-context.md` file grows too large.

## Files in this fork

- `examples/opencode/oracle-agent.js` — customized OpenCode Oracle bridge plugin.
- `examples/opencode/oracle-config.json5` — example Oracle config snippet that raises the per-file attachment cap to 4 MB.

## What changed

The OpenCode plugin customization does two things:

1. Raises the Oracle attachment ceiling via `maxFileSizeBytes: 4194304` so context bundles a little over 1 MB do not fail immediately.
2. Bounds the generated `opencode-session-context.md` file before Oracle sees it.

The plugin keeps the newest session in full, compacts the next sessions, summarizes older ones by omission/truncation rules, and drops the oldest transcript blocks if the generated bundle still exceeds the configured context budget.

This is deterministic pruning, not LLM summarization.

## Install locally

Copy the plugin example into your OpenCode config:

```bash
mkdir -p ~/.config/opencode/plugins
cp examples/opencode/oracle-agent.js ~/.config/opencode/plugins/oracle-agent.js
```

Merge the Oracle config example into `~/.oracle/config.json`:

```bash
cp examples/opencode/oracle-config.json5 ~/.oracle/config.json
```

If you already have settings in `~/.oracle/config.json`, merge just the `maxFileSizeBytes` value instead of overwriting the file.

## Tuning knobs

The plugin supports these environment variables:

- `ORACLE_OPENCODE_MAX_CONTEXT_FILE_BYTES`
- `ORACLE_OPENCODE_FULL_TRANSCRIPT_SESSIONS`
- `ORACLE_OPENCODE_COMPACT_TRANSCRIPT_SESSIONS`
- `ORACLE_OPENCODE_MAX_TEXT_CHARS`
- `ORACLE_OPENCODE_MAX_TOOL_OUTPUT_CHARS`
- `ORACLE_OPENCODE_MAX_JSON_CHARS`

## Caveat

This integration file lives outside the published Oracle package. It is stored here as a fork-local OpenCode companion artifact, not as shipped CLI runtime code.
