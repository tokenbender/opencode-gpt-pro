import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  buildQueryProfile,
  loadCachedSessionArtifacts,
  makeSessionArtifact,
  mergeSessionArtifacts,
  persistSessionArtifacts,
  renderRetrievedMemorySection,
  selectRetrievedArtifacts,
} from "../examples/opencode/oracle-agent-memory.js"

function loadFixture(name) {
  const filePath = fileURLToPath(new URL(`./fixtures/opencode-memory/${name}`, import.meta.url))
  return JSON.parse(readFileSync(filePath, "utf8"))
}

describe("OpenCode query-aware retrieval", () => {
  it("retrieves older relevant session artifacts and excludes protected or irrelevant sessions", () => {
    const fixture = loadFixture("retrieval-candidates.json")
    const artifacts = fixture.sessions.map((item) =>
      makeSessionArtifact({
        session: item.session,
        entries: item.entries,
        worktree: fixture.worktree,
      }),
    )

    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "opencode-retrieval-test-"))

    try {
      persistSessionArtifacts({
        oracleHomeDir: tempRoot,
        worktree: fixture.worktree,
        sessionArtifacts: artifacts,
      })

      const cachedArtifacts = loadCachedSessionArtifacts({
        oracleHomeDir: tempRoot,
        worktree: fixture.worktree,
      })
      const mergedArtifacts = mergeSessionArtifacts({
        liveSessionArtifacts: artifacts.slice(-2),
        cachedSessionArtifacts: cachedArtifacts,
      })
      const queryProfile = buildQueryProfile({
        prompt: fixture.prompt,
        attachedFiles: fixture.attachedFiles,
        recentArtifacts: artifacts.slice(-2),
        worktree: fixture.worktree,
      })
      const protectedSessionIds = new Set(
        artifacts.slice(-fixture.protectedSessionCount).map((artifact) => artifact.sessionId),
      )

      const retrieval = selectRetrievedArtifacts({
        sessionArtifacts: mergedArtifacts,
        queryProfile,
        protectedSessionIds,
        maxBytes: 2400,
      })
      const retrievedIds = retrieval.items.map((item) => item.artifact.sessionId)
      const renderedSection = renderRetrievedMemorySection(retrieval.items).join("\n")

      expect(queryProfile.files).toContain("src/oracle/files.ts")
      expect(queryProfile.symbols).toContain("buildContextMarkdown")
      expect(retrievedIds).toContain("sess-old-error")
      expect(retrievedIds).toContain("sess-old-decision")
      expect(retrievedIds).not.toContain("sess-old-irrelevant")
      expect(retrievedIds).not.toContain("sess-current-protected")
      expect(renderedSection).toContain("## Retrieved session memory")
      expect(renderedSection).toContain("Session sess-old-error")
      expect(renderedSection).toContain("Matched on:")
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("falls back cleanly when cache is missing or nothing matches the query", () => {
    const emptyRoot = mkdtempSync(path.join(os.tmpdir(), "opencode-retrieval-empty-"))

    try {
      const cachedArtifacts = loadCachedSessionArtifacts({
        oracleHomeDir: emptyRoot,
        worktree: "/repo",
      })
      const queryProfile = buildQueryProfile({
        prompt: "Summarize browser profile setup.",
        attachedFiles: [],
        recentArtifacts: [],
        worktree: "/repo",
      })
      const retrieval = selectRetrievedArtifacts({
        sessionArtifacts: cachedArtifacts,
        queryProfile,
        protectedSessionIds: new Set(),
        maxBytes: 1000,
      })

      expect(cachedArtifacts).toEqual([])
      expect(retrieval.items).toEqual([])
      expect(renderRetrievedMemorySection(retrieval.items)).toEqual([])
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })
})
