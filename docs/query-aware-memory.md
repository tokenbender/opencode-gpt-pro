# Query-Aware Memory Plan

This document lays out a practical plan for adding query-aware retrieval and controlled summarization to the OpenCode bridge in `opencode-gpt-pro`.

It assumes the current baseline already exists:

- hard byte budgeting for `opencode-session-context.md`
- deterministic transcript compaction by recency
- deterministic structured extraction and cache artifacts under `~/.oracle/opencode-memory/`
- browser-native GPT Pro execution through Oracle

The purpose of this plan is to make old session context recoverable because it is relevant, not only because it is recent.

## Current baseline

The current bridge behavior lives in `examples/opencode/oracle-agent.js`.

- `renderMessage(...)` renders message content with mode-dependent truncation.
- `selectTranscriptBlocks(...)` chooses full, compact, or summary blocks by age and byte budget.
- `buildContextMarkdown(...)` assembles the final attachment and drops oldest blocks if the budget is still exceeded.

That gives the system a reliable first safety layer. The repo now also has a deterministic memory layer plus an initial heuristic retrieval pass over cached session artifacts.

## Current implementation status

- Phase 1 is implemented.
- Phase 2 now exists in a first-pass heuristic form.
- Phase 3 and later remain planned work.

Current code paths:

- `examples/opencode/oracle-agent-memory.js`
  - `buildQueryProfile(...)`
  - `loadCachedSessionArtifacts(...)`
  - `scoreSessionArtifact(...)`
  - `selectRetrievedArtifacts(...)`
  - `renderRetrievedMemorySection(...)`
- `examples/opencode/oracle-agent.js`
  - persists cache artifacts
  - builds query-aware retrieved memory before the transcript section
  - still falls back to deterministic compaction if retrieval yields nothing useful

## Problem to solve

Long coding sessions do not decay by age alone.

In practice, old context can remain critical because it contains:

- a file path that matters again later
- a symbol or module discussed early in the session
- a decision that later work must honor
- an error message that explains current behavior
- a user preference or hard constraint

Pure recency pruning fails when the current prompt depends on one of those older artifacts.

## Design principles

1. Keep deterministic hard limits.
2. Prefer auditable structure over opaque prose.
3. Retrieve old context only when the current query justifies it.
4. Preserve provenance for anything summarized or retrieved.
5. Degrade gracefully to the current deterministic baseline.
6. Add LLM summarization only after deterministic extraction and retrieval are working.

## Target architecture

The bridge should move from a single transcript stream to four layers.

### 1. Working memory

The current turn and recent high-fidelity transcript.

- current prompt
- active session block(s)
- recent tool outputs
- attached local artifacts

### 2. Structured session memory

Deterministically extracted state from each session block.

- files mentioned or changed
- symbols and identifiers
- commands run
- errors and failing tests
- decisions made
- unresolved questions
- user constraints

### 3. Episodic memory

Compact records for older session ranges.

- block-level metadata
- structured summaries
- provenance back to source session and message ids

### 4. Project memory

Durable facts that should survive topic drift.

- repo conventions
- known setup constraints
- recurring commands
- stable architectural decisions

The bridge should assemble a final attachment from these layers under a fixed budget.

## Implementation surface in the current bridge

The first implementation can stay inside `examples/opencode/oracle-agent.js` rather than immediately splitting into multiple modules.

Add new helpers around the existing flow:

- `buildQueryProfile(...)`
- `extractStructuredFacts(...)`
- `buildSessionArtifacts(...)`
- `scoreSessionBlock(...)`
- `selectRetrievedBlocks(...)`
- `summarizeOversizeBlock(...)`
- `assembleBudgetedContext(...)`
- `loadMemoryCache(...)`
- `saveMemoryCache(...)`

Then change `buildContextMarkdown(...)` so it no longer depends only on `selectTranscriptBlocks(...)`.

## Data model

The bridge needs explicit artifacts, even if they are stored as JSON files at first.

### Query profile

Built from the current request and live context.

- prompt text
- normalized keywords
- file paths mentioned in the prompt
- symbols mentioned in the prompt
- files currently attached
- files referenced in the newest session block

### Session block artifact

One record per rendered session block or per message range.

- `sessionId`
- `messageIds`
- `mode` (`full`, `compact`, `summary`, `retrieved`)
- `byteSize`
- `text`
- `files`
- `symbols`
- `commands`
- `errors`
- `decisions`
- `openQuestions`
- `timestampRange`

### Summary artifact

Only for blocks that have been summarized.

- `summaryId`
- `sourceSessionId`
- `sourceMessageIds`
- `schemaVersion`
- `summaryType` (`deterministic`, `llm_structured`)
- `summaryText`
- `facts`
- `generatedAt`
- `sourceFingerprint`

### Cache location

Use a local cache under the Oracle home directory so the bridge can survive restarts.

- default root: `${ORACLE_HOME_DIR}/opencode-memory/`
- partition by worktree hash
- keep separate files for block artifacts and summaries

This stays local and does not change Oracle runtime behavior.

## Phase 1: structured extraction first

Before retrieval, the bridge should extract deterministic structure from raw session history.

### Extract now

- file paths from file parts, patch parts, diff summaries, and tool attachments
- likely symbols from filenames, patch names, and prompt tokens
- command strings from tool inputs and shell-like outputs
- errors from failed tool calls and assistant error fields
- decision cues from phrases like `decided`, `must`, `constraint`, `use`, `do not`
- unresolved items from phrases like `todo`, `next`, `follow up`, `remaining`

### Why this comes first

- no extra model call
- low hallucination risk
- directly supports retrieval scoring
- directly supports future structured summaries

## Phase 2: query-aware retrieval

Once block artifacts exist, score old blocks against the current query.

### Retrieval candidates

Start from anything outside the always-keep recent window.

- compact blocks
- summary blocks
- omitted older blocks with cached artifacts

### Initial scoring features

Use a weighted heuristic first.

- exact file path overlap
- basename overlap
- symbol overlap
- lexical overlap with the prompt
- overlap with attached local artifacts
- overlap with newest session files
- error string overlap
- decision or constraint overlap
- recency bonus

### Initial scoring formula

Start with an additive score, then tune using fixtures.

Example shape:

```text
score =
  5.0 * exact_path_overlap
  + 3.0 * basename_overlap
  + 3.0 * symbol_overlap
  + 2.5 * lexical_overlap
  + 2.0 * attached_file_overlap
  + 1.5 * recent_session_overlap
  + 1.5 * error_overlap
  + 1.0 * decision_overlap
  + 0.5 * recency_bonus
```

This is intentionally simple. The first win is moving away from age-only selection.

### Selection policy

After ranking:

1. reserve budget for the current prompt and newest raw transcript
2. reserve budget for attached artifact listing
3. fill a retrieval bucket with top-ranked old blocks
4. summarize only the retrieved blocks that still do not fit
5. fall back to dropping lowest-ranked retrieved blocks if needed

## Phase 3: controlled summarization

Summarization should begin as structured, bounded, and provenance-aware.

### Do not start with

- one giant summary of the full lineage
- eager summarization of every session
- summary text with no source references

### Start with

selected stale blocks that were ranked as relevant but are too large to include raw.

### Summary schema

Each summary should preserve:

- user requirements
- key decisions
- files and symbols involved
- errors and test state
- unresolved questions
- source session ids
- source message ids

### Summary modes

#### Deterministic structured summary

Build from extracted facts only.

- safest
- cheapest
- easiest to validate

#### LLM structured summary

Add only after deterministic retrieval is stable.

- use a strict schema
- include provenance fields
- cache the result
- invalidate if the source fingerprint changes

This is where OpenHands is the best implementation reference.

## Phase 4: hierarchical assembly

The final context builder should assemble the attachment in layers.

### Suggested order

1. task header and execution context
2. attached local artifacts
3. current working memory
4. retrieved episodic memory
5. compact project memory
6. budget notes and omissions

### Budget buckets

Use explicit byte buckets rather than one undifferentiated pool.

- 35 percent current working memory
- 30 percent retrieved old blocks
- 20 percent summaries
- 10 percent project memory
- 5 percent notes and slack

The exact numbers can change. The important thing is to make the allocation explicit and testable.

## Phase 5: optional hybrid retrieval

If lexical and structural retrieval are not enough, add a semantic layer.

### Good second-stage options

- local embeddings over cached session artifacts
- reranking after heuristic retrieval
- hybrid lexical plus vector scoring

### Not needed initially

- model-side KV-cache compression
- custom long-context serving tricks
- any system that requires owning GPT Pro inference

The immediate bottleneck is pre-inference context assembly, not model internals.

## Caching and invalidation

The bridge should avoid recomputing summaries and features on every consult.

### Cache keys

- worktree root
- session id
- message id range
- source fingerprint from message metadata and rendered text
- summary schema version

### Invalidate when

- a source message range changes
- a session gains new messages
- summary schema changes
- extraction logic version changes

## Failure handling

The system should always be able to fall back.

### Required fallback order

1. query-aware retrieval with cached artifacts
2. deterministic structured summaries
3. current recency-based compaction
4. hard byte-budget truncation

If any retrieval or summarization stage fails, Oracle consult should still run.

## Evaluation plan

Build fixtures before tuning weights.

### Core scenarios

1. the current prompt refers to a file discussed 30 turns ago
2. the current prompt depends on an old error message
3. the current prompt depends on a decision made in a prior session
4. recent chatter is irrelevant and should lose to an older relevant block
5. a very long stale block must be summarized, not dropped blindly
6. the final bundle must remain under the byte budget in all cases

### Metrics

- did the relevant old fact appear in the final bundle
- did the final bundle stay within byte budget
- how often retrieval beat pure recency
- how often summaries were used
- how often the system fell back to deterministic pruning

## Best external references

### Query-aware retrieval

- `letta-ai/letta`
  - `letta/services/message_manager.py`
  - `letta/helpers/tpuf_client.py`
  - `letta/services/agent_manager.py`

Best reference for hybrid recall search and archival memory retrieval.

### Controlled summarization

- `All-Hands-AI/OpenHands`
  - `openhands/memory/condenser/impl/structured_summary_condenser.py`
  - `openhands/memory/condenser/impl/llm_summarizing_condenser.py`
  - `openhands/memory/condenser/impl/llm_attention_condenser.py`

Best reference for rolling condensation and structured summaries.

### Repo-aware selection

- `Aider-AI/aider`
  - `aider/repomap.py`

Best reference for file and symbol ranking shaped by the current task.

### Memory primitives

- `run-llama/llama_index`
  - vector memory blocks
  - fact extraction blocks
  - summary buffer memory
- `mem0ai/mem0`
  - retrieval plus reranking patterns

## Recommended rollout

### Milestone 1

Add deterministic structured extraction and cache it.

Deliverables:

- session artifact builder
- cache format
- fixtures for extraction correctness

### Milestone 2

Add heuristic query-aware ranking and budgeted retrieval.

Deliverables:

- query profile builder
- scoring function
- retrieval bucket in final context assembly

### Milestone 3

Add deterministic structured summaries for oversized retrieved blocks.

Deliverables:

- summary schema
- provenance format
- invalidation rules

### Milestone 4

Add optional LLM structured summaries and reranking.

Deliverables:

- opt-in summarization mode
- cached summaries
- retrieval quality comparison against heuristic-only mode

## Bottom line

The first meaningful upgrade is not a fancy model trick. It is a better contract between the current query, older session artifacts, and the byte budget.

For `opencode-gpt-pro`, the right sequence is:

- deterministic extraction
- query-aware retrieval
- structured summarization
- optional semantic retrieval and reranking

That keeps the current system reliable while making old context recoverable for the cases that actually matter.
