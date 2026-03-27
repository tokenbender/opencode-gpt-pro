# opencode-gpt-pro

`opencode-gpt-pro` is a working fork of `steipete/oracle` aimed at one specific job: making GPT Pro in ChatGPT usable as a dependable backend for OpenCode.

The upstream Oracle codebase already has the hard parts of browser automation, file bundling, session storage, remote browser bridging, and MCP. This fork keeps that base and pushes it toward an OpenCode-first workflow where long-lived sessions, forwarded repo context, and browser-bound GPT Pro runs need to work together without constant manual recovery.

## Why this fork exists

The immediate trigger was practical rather than theoretical.

- OpenCode's Oracle bridge forwarded a full `opencode-session-context.md` transcript.
- Oracle rejected that attachment once it crossed the local per-file size guard.
- The failure happened before ChatGPT or GPT Pro ever saw the request.

This fork exists to close that gap and then keep moving in the same direction: fewer brittle handoffs, better browser defaults, and a cleaner OpenCode integration story.

## What is different here

- The repo is positioned around OpenCode + GPT Pro, not a generic model router first.
- It carries OpenCode companion artifacts under `examples/opencode/`.
- The recommended local config raises Oracle's file attachment cap so OpenCode consults do not fail at 1 MB.
- The OpenCode bridge plugin included here bounds the forwarded session transcript before it is attached.
- The transcript compaction is deterministic. It trims and drops older context by budget. It does not call another model to summarize your session.

## Current status

- The codebase is still derived from `steipete/oracle`.
- The package and binary names are still `@steipete/oracle` and `oracle`.
- Most of the CLI, browser, bridge, and MCP surface remains compatible with upstream.
- The active fork-specific work is concentrated on OpenCode integration, browser-first GPT Pro defaults, and context handoff reliability.

## Quick start

If you want the fork in the way it is intended to be used today:

```bash
git clone https://github.com/tokenbender/opencode-gpt-pro.git
cd opencode-gpt-pro
bun install
bun run opencode:sync
```

`bun run opencode:sync` bundles the split OpenCode bridge source into a single deployed `oracle-agent.js` file inside `~/.config/opencode/plugins/`.

Then merge the recommended settings from `examples/opencode/oracle-config.json5` into `~/.oracle/config.json`.

At minimum, this fork currently expects:

```json5
{
  maxFileSizeBytes: 4194304,
  browser: {
    modelStrategy: "current",
  },
}
```

Restart OpenCode after copying the plugin.

## How to read this repo

- `docs/opencode.md` explains the OpenCode integration, the current context-budgeting behavior, and the install path.
- `docs/query-aware-memory.md` lays out the next memory architecture and the current Milestone 1 extraction layer.
- `docs/roadmap.md` states where the fork is headed and what is intentionally not changing yet.
- `docs/configuration.md` remains the reference for Oracle config shape and now includes the recommended fork baseline.
- `docs/bridge.md` covers the remote-browser workflow when ChatGPT lives on another machine.
- `examples/opencode/` contains the fork-specific companion files that are not yet part of the published package surface.

## Direction

The near-term direction is straightforward.

- Make OpenCode the primary integration target rather than an afterthought.
- Treat GPT Pro in ChatGPT as a first-class execution environment, not only a manual fallback.
- Productize the context handoff layer so long sessions stay usable.
- Preserve upstream Oracle capabilities when they help, and diverge only where OpenCode-specific needs justify it.

## Relationship to upstream

This repo is not a clean-room rewrite. It is an opinionated fork.

Upstream Oracle still provides the core CLI runtime, browser machinery, remote bridge, MCP server, and session model. The plan is to keep syncing with upstream where that improves reliability, while using this fork to move faster on the OpenCode and GPT Pro path.

If you want the general-purpose upstream tool, use `steipete/oracle`. If you want the OpenCode-first fork direction, use this repo.
