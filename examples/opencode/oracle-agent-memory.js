import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const MEMORY_SCHEMA_VERSION = 1
const MAX_SEARCH_TEXT_CHARS = 12000

const COMMAND_PREFIXES = [
  "bun ",
  "npm ",
  "pnpm ",
  "yarn ",
  "node ",
  "python ",
  "python3 ",
  "git ",
  "oracle ",
  "npx ",
  "tsx ",
  "vitest ",
  "pytest ",
  "cargo ",
  "go ",
  "make ",
  "bash ",
  "sh ",
]

const SYMBOL_STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "answer",
  "attached",
  "before",
  "browser",
  "build",
  "bundle",
  "change",
  "changes",
  "check",
  "code",
  "config",
  "context",
  "current",
  "default",
  "details",
  "directory",
  "docs",
  "engine",
  "error",
  "false",
  "file",
  "files",
  "final",
  "follow",
  "history",
  "issue",
  "local",
  "memory",
  "message",
  "messages",
  "model",
  "oracle",
  "output",
  "plugin",
  "profile",
  "project",
  "prompt",
  "query",
  "recent",
  "repo",
  "session",
  "state",
  "summary",
  "system",
  "task",
  "text",
  "tool",
  "tools",
  "true",
  "update",
  "user",
  "using",
  "work",
  "worktree",
])

const CONSTRAINT_PATTERN = /\b(must|must not|do not|don't|never|only|required|constraint|preserve|keep)\b/i
const DECISION_PATTERN = /\b(decid(?:e|ed|ing)|prefer|use|choose|chosen|select|selected|adopt|stick with|defer)\b/i
const OPEN_QUESTION_PATTERN = /\b(todo|next step|follow up|remaining|pending|later|investigate|need to|still need|plan)\b/i
const PATH_PATTERN = /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.[A-Za-z]{2,10}/g
const FILE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "mjs",
  "md",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "yaml",
  "yml",
])
const KEYWORD_STOP_WORDS = new Set([
  ...SYMBOL_STOP_WORDS,
  "into",
  "from",
  "this",
  "that",
  "these",
  "those",
  "them",
  "then",
  "than",
  "the",
  "and",
  "why",
  "how",
  "for",
  "not",
  "when",
  "what",
  "where",
  "which",
  "while",
  "should",
  "would",
  "could",
  "there",
  "their",
  "about",
  "because",
  "through",
  "under",
  "over",
  "have",
  "with",
  "without",
])
const DEFAULT_QUERY_KEYWORD_LIMIT = 24
const DEFAULT_RETRIEVAL_MIN_SCORE = 2.5
const MAX_RETRIEVED_EXCERPT_CHARS = 280
const MAX_RETRIEVED_MATCHES = 4

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function truncateText(text, max) {
  if (!text || text.length <= max) return text
  return text.slice(0, max)
}

function byteLength(text) {
  return Buffer.byteLength(text ?? "", "utf8")
}

function stableHash(value) {
  return createHash("sha1").update(value).digest("hex")
}

function addUnique(list, seen, value, maxItems = Infinity) {
  const normalized = normalizeText(value)
  if (!normalized || list.length >= maxItems) return
  const key = normalized.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  list.push(normalized)
}

function relPath(targetPath, worktree) {
  if (!targetPath) return ""
  if (!worktree || !path.isAbsolute(targetPath)) return targetPath
  const relative = path.relative(worktree, targetPath)
  if (!relative || relative.startsWith("..")) return targetPath
  return relative
}

function decodeFileUrl(url) {
  if (!url || !url.startsWith("file://")) return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function fileUrlToPath(url) {
  const parsed = decodeFileUrl(url)
  if (!parsed) return null
  const pathname = decodeURIComponent(parsed.pathname)
  if (process.platform === "win32" && pathname.startsWith("/")) {
    return pathname.slice(1)
  }
  return pathname
}

function cleanPathCandidate(value) {
  const candidate = normalizeText(value).replace(/^[`'"(\[]+|[`'"),.;:\]]+$/g, "")
  if (!candidate || candidate.startsWith("http://") || candidate.startsWith("https://")) return ""
  if (!candidate.includes("/") && !candidate.includes("\\")) {
    const extension = path.extname(candidate).slice(1).toLowerCase()
    if (!FILE_EXTENSIONS.has(extension)) return ""
  }
  return candidate
}

function addPath(paths, seen, candidate, worktree, maxItems = 48) {
  const cleaned = cleanPathCandidate(candidate)
  if (!cleaned) return
  const maybeRelative = relPath(cleaned, worktree)
  addUnique(paths, seen, maybeRelative, maxItems)
}

function looksLikeSymbol(token) {
  if (!token || token.length < 3) return false
  const lower = token.toLowerCase()
  if (SYMBOL_STOP_WORDS.has(lower)) return false
  return /[_$]/.test(token) || /[a-z][A-Z]/.test(token) || /^[A-Z][A-Za-z0-9]+$/.test(token)
}

function addSymbolsFromText(symbols, seen, text, maxItems = 64) {
  const matches = String(text ?? "").match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? []
  for (const token of matches) {
    if (!looksLikeSymbol(token)) continue
    addUnique(symbols, seen, token, maxItems)
    if (symbols.length >= maxItems) return
  }
}

function addSymbolsFromPath(symbols, seen, filePath, maxItems = 64) {
  const cleaned = cleanPathCandidate(filePath)
  if (!cleaned) return
  const base = path.basename(cleaned).replace(/\.[^.]+$/, "")
  addSymbolsFromText(symbols, seen, base, maxItems)
}

function addPathCandidatesFromText(paths, pathSeen, symbols, symbolSeen, text, worktree) {
  const matches = String(text ?? "").match(PATH_PATTERN) ?? []
  for (const match of matches) {
    addPath(paths, pathSeen, match, worktree)
    addSymbolsFromPath(symbols, symbolSeen, match)
  }
}

function looksLikeShellCommand(text) {
  const normalized = normalizeText(text)
  if (!normalized) return false
  if (normalized.includes(" && ") || normalized.includes(" || ") || normalized.includes(" | ")) return true
  return COMMAND_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

function collectCommands(commands, seen, value, keyHint = "", maxItems = 24) {
  if (value == null || commands.length >= maxItems) return
  if (typeof value === "string") {
    const normalized = normalizeText(value)
    if (keyHint === "command" || keyHint === "cmd" || keyHint === "script" || looksLikeShellCommand(normalized)) {
      addUnique(commands, seen, normalized, maxItems)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCommands(commands, seen, item, keyHint, maxItems)
      if (commands.length >= maxItems) return
    }
    return
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      collectCommands(commands, seen, nested, key, maxItems)
      if (commands.length >= maxItems) return
    }
  }
}

function addSearchFragment(fragments, text) {
  const normalized = normalizeText(text)
  if (!normalized) return
  fragments.push(truncateText(normalized, 600))
}

function tokenizeKeywords(text, maxItems = DEFAULT_QUERY_KEYWORD_LIMIT) {
  const tokens = String(text ?? "").match(/[A-Za-z0-9_./-]{3,}/g) ?? []
  const keywords = []
  const seen = new Set()
  for (const token of tokens) {
    const normalized = token.replace(/^[-_.\/]+|[-_.\/]+$/g, "").toLowerCase()
    if (!normalized || normalized.length < 3 || /^\d+$/.test(normalized)) continue
    if (KEYWORD_STOP_WORDS.has(normalized)) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    keywords.push(normalized)
    if (keywords.length >= maxItems) break
  }
  return keywords
}

function lowerCaseSet(values) {
  return new Set((values ?? []).map((value) => normalizeText(value).toLowerCase()).filter(Boolean))
}

function countIntersection(left, right) {
  if (!left?.length || !right?.length) return 0
  const leftSet = lowerCaseSet(left)
  const rightSet = lowerCaseSet(right)
  let count = 0
  for (const value of leftSet) {
    if (rightSet.has(value)) count += 1
  }
  return count
}

function collectBasenames(filePaths, maxItems = 32) {
  const basenames = []
  const seen = new Set()
  for (const filePath of filePaths ?? []) {
    const cleaned = cleanPathCandidate(filePath)
    if (!cleaned) continue
    addUnique(basenames, seen, path.basename(cleaned).replace(/\.[^.]+$/, ""), maxItems)
    if (basenames.length >= maxItems) break
  }
  return basenames
}

function formatScore(score) {
  return Number(score).toFixed(1).replace(/\.0$/, "")
}

function compareArtifactsByRecency(left, right) {
  const leftKey = normalizeText(left?.timestampRange?.end || left?.timestampRange?.start || "")
  const rightKey = normalizeText(right?.timestampRange?.end || right?.timestampRange?.start || "")
  if (leftKey && rightKey && leftKey !== rightKey) {
    return leftKey.localeCompare(rightKey)
  }
  return String(left?.sessionId ?? "").localeCompare(String(right?.sessionId ?? ""))
}

function addStructuredSignals(bucket, text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
  for (const line of lines) {
    if (line.length < 10 || line.length > 260) continue
    if (CONSTRAINT_PATTERN.test(line)) {
      addUnique(bucket.constraints, bucket.constraintSeen, line, 16)
    }
    if (DECISION_PATTERN.test(line)) {
      addUnique(bucket.decisions, bucket.decisionSeen, line, 16)
    }
    if (OPEN_QUESTION_PATTERN.test(line)) {
      addUnique(bucket.openQuestions, bucket.openQuestionSeen, line, 16)
    }
  }
}

function addError(errors, seen, value, maxItems = 16) {
  const normalized = normalizeText(value)
  if (!normalized) return
  addUnique(errors, seen, truncateText(normalized, 400), maxItems)
}

function addTimestamp(timestampRange, value) {
  const normalized = normalizeText(value)
  if (!normalized) return
  if (!timestampRange.start || normalized < timestampRange.start) timestampRange.start = normalized
  if (!timestampRange.end || normalized > timestampRange.end) timestampRange.end = normalized
}

function buildSearchText(fragments, fields) {
  const joined = [...fragments, ...fields].map((item) => normalizeText(item)).filter(Boolean).join("\n")
  return truncateText(joined, MAX_SEARCH_TEXT_CHARS)
}

function makeSessionArtifact({ session, entries, worktree }) {
  const files = []
  const fileSeen = new Set()
  const symbols = []
  const symbolSeen = new Set()
  const commands = []
  const commandSeen = new Set()
  const errors = []
  const errorSeen = new Set()
  const decisions = []
  const decisionSeen = new Set()
  const constraints = []
  const constraintSeen = new Set()
  const openQuestions = []
  const openQuestionSeen = new Set()
  const messageIds = []
  const messageIdSeen = new Set()
  const searchFragments = []
  const timestampRange = { start: null, end: null }

  const signalBucket = {
    decisions,
    decisionSeen,
    constraints,
    constraintSeen,
    openQuestions,
    openQuestionSeen,
  }

  for (const entry of entries ?? []) {
    if (entry?.info?.id) addUnique(messageIds, messageIdSeen, entry.info.id, Infinity)
    addTimestamp(timestampRange, entry?.info?.createdAt)
    addTimestamp(timestampRange, entry?.info?.updatedAt)
    addTimestamp(timestampRange, entry?.info?.time)

    if (entry?.info?.summary?.title) {
      addSearchFragment(searchFragments, entry.info.summary.title)
      addStructuredSignals(signalBucket, entry.info.summary.title)
    }
    if (entry?.info?.summary?.body) {
      addSearchFragment(searchFragments, entry.info.summary.body)
      addStructuredSignals(signalBucket, entry.info.summary.body)
      addPathCandidatesFromText(files, fileSeen, symbols, symbolSeen, entry.info.summary.body, worktree)
      addSymbolsFromText(symbols, symbolSeen, entry.info.summary.body)
    }
    for (const diff of entry?.info?.summary?.diffs ?? []) {
      addPath(files, fileSeen, diff.file, worktree)
      addSymbolsFromPath(symbols, symbolSeen, diff.file)
    }

    if (entry?.info?.error) {
      addError(errors, errorSeen, typeof entry.info.error === "string" ? entry.info.error : JSON.stringify(entry.info.error))
    }

    for (const part of entry?.parts ?? []) {
      if (part.type === "text") {
        addSearchFragment(searchFragments, part.text)
        addStructuredSignals(signalBucket, part.text)
        addPathCandidatesFromText(files, fileSeen, symbols, symbolSeen, part.text, worktree)
        addSymbolsFromText(symbols, symbolSeen, part.text)
        continue
      }

      if (part.type === "subtask") {
        addSearchFragment(searchFragments, part.description)
        addSearchFragment(searchFragments, part.prompt)
        addStructuredSignals(signalBucket, part.description)
        addStructuredSignals(signalBucket, part.prompt)
        addPathCandidatesFromText(files, fileSeen, symbols, symbolSeen, part.prompt, worktree)
        addSymbolsFromText(symbols, symbolSeen, part.prompt)
        continue
      }

      if (part.type === "file") {
        addPath(files, fileSeen, part.source?.path, worktree)
        addPath(files, fileSeen, fileUrlToPath(part.url), worktree)
        addPath(files, fileSeen, part.filename, worktree)
        addSymbolsFromPath(symbols, symbolSeen, part.source?.path ?? part.filename ?? part.url)
        continue
      }

      if (part.type === "patch") {
        for (const file of part.files ?? []) {
          addPath(files, fileSeen, file, worktree)
          addSymbolsFromPath(symbols, symbolSeen, file)
        }
        continue
      }

      if (part.type === "tool") {
        addSearchFragment(searchFragments, part.tool)
        addSearchFragment(searchFragments, part.state?.title)
        collectCommands(commands, commandSeen, part.state?.input)
        if (part.state?.input) {
          const serializedInput = JSON.stringify(part.state.input)
          addPathCandidatesFromText(files, fileSeen, symbols, symbolSeen, serializedInput, worktree)
          addSymbolsFromText(symbols, symbolSeen, serializedInput)
        }
        if (part.state?.output) {
          const outputPreview = truncateText(String(part.state.output), 4000)
          addSearchFragment(searchFragments, outputPreview)
          addPathCandidatesFromText(files, fileSeen, symbols, symbolSeen, outputPreview, worktree)
          addSymbolsFromText(symbols, symbolSeen, outputPreview)
          addStructuredSignals(signalBucket, outputPreview)
        }
        if (part.state?.error) {
          addError(errors, errorSeen, part.state.error)
          addStructuredSignals(signalBucket, part.state.error)
        }
        for (const attachment of part.state?.attachments ?? []) {
          addPath(files, fileSeen, attachment.source?.path, worktree)
          addPath(files, fileSeen, fileUrlToPath(attachment.url), worktree)
        }
        continue
      }

      if (part.type === "retry") {
        addError(errors, errorSeen, typeof part.error === "string" ? part.error : JSON.stringify(part.error))
        continue
      }

      if (part.type === "agent") {
        addSearchFragment(searchFragments, part.name)
      }
    }
  }

  const searchText = buildSearchText(searchFragments, [
    ...files,
    ...symbols,
    ...commands,
    ...errors,
    ...decisions,
    ...constraints,
    ...openQuestions,
  ])

  const artifact = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sessionId: session.id,
    parentID: session.parentID ?? null,
    title: session.title ?? "",
    directory: session.directory ?? "",
    worktree: worktree ?? session.directory ?? "",
    messageIds,
    timestampRange,
    files,
    symbols,
    commands,
    errors,
    decisions,
    constraints,
    openQuestions,
    searchText,
    keywords: tokenizeKeywords(searchText, 96),
  }

  return {
    ...artifact,
    sourceFingerprint: stableHash(JSON.stringify(artifact)),
  }
}

function collectRecentUnique(artifacts, key, maxItems) {
  const values = []
  const seen = new Set()
  for (const artifact of [...artifacts].reverse()) {
    for (const value of artifact[key] ?? []) {
      addUnique(values, seen, value, maxItems)
      if (values.length >= maxItems) return values
    }
  }
  return values
}

function formatList(values, maxItems = 8) {
  if (!values.length) return ""
  const visible = values.slice(0, maxItems)
  const suffix = values.length > maxItems ? `, +${values.length - maxItems} more` : ""
  return `${visible.join(", ")}${suffix}`
}

function buildStructuredMemorySection(sessionArtifacts) {
  if (!sessionArtifacts?.length) return []
  const lines = []
  const files = collectRecentUnique(sessionArtifacts, "files", 12)
  const symbols = collectRecentUnique(sessionArtifacts, "symbols", 12)
  const commands = collectRecentUnique(sessionArtifacts, "commands", 8)
  const errors = collectRecentUnique(sessionArtifacts, "errors", 8)
  const decisions = collectRecentUnique(sessionArtifacts, "decisions", 8)
  const constraints = collectRecentUnique(sessionArtifacts, "constraints", 8)
  const openQuestions = collectRecentUnique(sessionArtifacts, "openQuestions", 8)

  lines.push("## Structured session memory")
  lines.push(`- Cached lineage sessions: ${sessionArtifacts.length}`)
  if (files.length) lines.push(`- Notable files: ${formatList(files, 8)}`)
  if (symbols.length) lines.push(`- Notable symbols: ${formatList(symbols, 8)}`)
  if (commands.length) lines.push(`- Commands observed: ${formatList(commands, 6)}`)
  if (errors.length) lines.push(`- Reported errors: ${formatList(errors, 4)}`)
  if (decisions.length) lines.push(`- Decisions: ${formatList(decisions, 4)}`)
  if (constraints.length) lines.push(`- Constraints: ${formatList(constraints, 4)}`)
  if (openQuestions.length) lines.push(`- Open questions: ${formatList(openQuestions, 4)}`)
  lines.push("")

  return lines
}

function buildQueryProfile({ prompt, attachedFiles = [], recentArtifacts = [], worktree }) {
  const files = []
  const fileSeen = new Set()
  const symbols = []
  const symbolSeen = new Set()
  addPathCandidatesFromText(files, fileSeen, symbols, symbolSeen, prompt, worktree)
  addSymbolsFromText(symbols, symbolSeen, prompt, 32)

  for (const file of attachedFiles) {
    addPath(files, fileSeen, file, worktree, 32)
    addSymbolsFromPath(symbols, symbolSeen, file, 32)
  }

  const recentFiles = collectRecentUnique(recentArtifacts, "files", 16)
  const recentSymbols = collectRecentUnique(recentArtifacts, "symbols", 16)
  const recentErrors = collectRecentUnique(recentArtifacts, "errors", 8)
  const recentDecisions = collectRecentUnique(recentArtifacts, "decisions", 8)
  const recentConstraints = collectRecentUnique(recentArtifacts, "constraints", 8)

  const keywords = tokenizeKeywords(
    [prompt, ...files, ...symbols, ...collectBasenames(files, 16)].join("\n"),
    DEFAULT_QUERY_KEYWORD_LIMIT,
  )

  return {
    prompt: normalizeText(prompt),
    keywords,
    files,
    basenames: collectBasenames(files, 16),
    symbols,
    recentFiles,
    recentBasenames: collectBasenames(recentFiles, 16),
    recentSymbols,
    errorKeywords: tokenizeKeywords(recentErrors.join("\n"), 16),
    decisionKeywords: tokenizeKeywords([...recentDecisions, ...recentConstraints].join("\n"), 16),
  }
}

function loadCachedSessionArtifacts({ oracleHomeDir, worktree }) {
  const sessionsDir = path.join(getWorktreeCacheDir(oracleHomeDir, worktree), "sessions")
  if (!existsSync(sessionsDir)) return []

  const artifacts = []
  for (const entry of readdirSync(sessionsDir).sort()) {
    if (!entry.endsWith(".json")) continue
    const filePath = path.join(sessionsDir, entry)
    const artifact = readJsonIfExists(filePath)
    if (!artifact?.sessionId) continue
    let cacheMtimeMs = 0
    try {
      cacheMtimeMs = statSync(filePath).mtimeMs
    } catch {
      cacheMtimeMs = 0
    }
    artifacts.push({ ...artifact, cacheMtimeMs })
  }

  return artifacts
    .sort((left, right) => {
      const recency = compareArtifactsByRecency(left, right)
      if (recency !== 0) return recency
      return Number(left.cacheMtimeMs ?? 0) - Number(right.cacheMtimeMs ?? 0)
    })
    .map(({ cacheMtimeMs: _cacheMtimeMs, ...artifact }) => artifact)
}

function mergeSessionArtifacts({ liveSessionArtifacts = [], cachedSessionArtifacts = [] }) {
  const merged = new Map()
  for (const artifact of cachedSessionArtifacts) {
    if (artifact?.sessionId) merged.set(artifact.sessionId, artifact)
  }
  for (const artifact of liveSessionArtifacts) {
    if (artifact?.sessionId) merged.set(artifact.sessionId, artifact)
  }
  return [...merged.values()].sort(compareArtifactsByRecency)
}

function buildRetrievedExcerpt(artifact) {
  const preferred = [
    ...(artifact.decisions ?? []),
    ...(artifact.constraints ?? []),
    ...(artifact.errors ?? []),
    ...(artifact.openQuestions ?? []),
    artifact.searchText,
  ]
    .map((value) => normalizeText(value))
    .find(Boolean)
  return truncateText(preferred ?? "", MAX_RETRIEVED_EXCERPT_CHARS)
}

function buildMatchReasons(breakdown) {
  const reasons = []
  if (breakdown.exactPathOverlap > 0) reasons.push(`exact paths x${breakdown.exactPathOverlap}`)
  if (breakdown.basenameOverlap > 0) reasons.push(`basenames x${breakdown.basenameOverlap}`)
  if (breakdown.symbolOverlap > 0) reasons.push(`symbols x${breakdown.symbolOverlap}`)
  if (breakdown.keywordOverlap > 0) reasons.push(`keywords x${breakdown.keywordOverlap}`)
  if (breakdown.recentFileOverlap > 0) reasons.push(`recent files x${breakdown.recentFileOverlap}`)
  if (breakdown.errorOverlap > 0) reasons.push(`errors x${breakdown.errorOverlap}`)
  if (breakdown.decisionOverlap > 0) reasons.push(`decisions x${breakdown.decisionOverlap}`)
  return reasons.slice(0, MAX_RETRIEVED_MATCHES)
}

function scoreSessionArtifact({ artifact, queryProfile, recencyRank = 0, candidateCount = 1 }) {
  const artifactFiles = artifact.files ?? []
  const artifactBasenames = collectBasenames(artifactFiles, 32)
  const artifactKeywords = artifact.keywords?.length ? artifact.keywords : tokenizeKeywords(artifact.searchText, 96)
  const artifactDecisionKeywords = tokenizeKeywords(
    [...(artifact.decisions ?? []), ...(artifact.constraints ?? []), ...(artifact.openQuestions ?? [])].join("\n"),
    48,
  )
  const artifactErrorKeywords = tokenizeKeywords([...(artifact.errors ?? []), artifact.searchText].join("\n"), 48)

  const breakdown = {
    exactPathOverlap: countIntersection(artifactFiles, queryProfile.files),
    basenameOverlap: countIntersection(artifactBasenames, queryProfile.basenames),
    symbolOverlap: countIntersection(artifact.symbols ?? [], queryProfile.symbols),
    keywordOverlap: countIntersection(artifactKeywords, queryProfile.keywords),
    recentFileOverlap:
      countIntersection(artifactFiles, queryProfile.recentFiles) +
      countIntersection(artifactBasenames, queryProfile.recentBasenames),
    errorOverlap: countIntersection(artifactErrorKeywords, queryProfile.errorKeywords),
    decisionOverlap: countIntersection(artifactDecisionKeywords, queryProfile.decisionKeywords),
    recencyBonus: candidateCount > 1 ? recencyRank / (candidateCount - 1) : 1,
  }

  const nonRecencyScore =
    5.0 * breakdown.exactPathOverlap +
    3.0 * breakdown.basenameOverlap +
    3.0 * breakdown.symbolOverlap +
    2.5 * breakdown.keywordOverlap +
    2.0 * breakdown.recentFileOverlap +
    1.5 * breakdown.errorOverlap +
    1.0 * breakdown.decisionOverlap

  const totalScore = nonRecencyScore + 0.5 * breakdown.recencyBonus

  return {
    artifact,
    score: totalScore,
    nonRecencyScore,
    breakdown,
    excerpt: buildRetrievedExcerpt(artifact),
    matches: buildMatchReasons(breakdown),
  }
}

function renderRetrievedArtifactEntry(item, compact = false) {
  const lines = []
  lines.push(`### Session ${item.artifact.sessionId} (score ${formatScore(item.score)})`)
  if (item.matches.length) lines.push(`- Matched on: ${item.matches.join(", ")}`)
  if (item.artifact.files?.length) lines.push(`- Files: ${formatList(item.artifact.files, compact ? 3 : 5)}`)
  if (item.artifact.decisions?.length) lines.push(`- Decisions: ${formatList(item.artifact.decisions, compact ? 2 : 3)}`)
  if (item.artifact.constraints?.length) lines.push(`- Constraints: ${formatList(item.artifact.constraints, compact ? 2 : 3)}`)
  if (item.artifact.errors?.length) lines.push(`- Errors: ${formatList(item.artifact.errors, compact ? 1 : 2)}`)
  if (!compact && item.excerpt) lines.push(`- Excerpt: ${item.excerpt}`)
  lines.push("")
  return `${lines.join("\n")}\n`
}

function selectRetrievedArtifacts({
  sessionArtifacts = [],
  queryProfile,
  protectedSessionIds = new Set(),
  maxBytes,
  minScore = DEFAULT_RETRIEVAL_MIN_SCORE,
}) {
  const candidates = sessionArtifacts.filter(
    (artifact) => artifact?.sessionId && !protectedSessionIds.has(artifact.sessionId),
  )
  const scored = candidates
    .map((artifact, index) =>
      scoreSessionArtifact({
        artifact,
        queryProfile,
        recencyRank: index,
        candidateCount: candidates.length,
      }),
    )
    .filter((item) => item.nonRecencyScore > 0 && item.score >= minScore)
    .sort((left, right) => right.score - left.score || compareArtifactsByRecency(right.artifact, left.artifact))

  const items = []
  let usedBytes = 0

  for (const item of scored) {
    const fullText = renderRetrievedArtifactEntry(item)
    const compactText = renderRetrievedArtifactEntry(item, true)
    const fullBytes = byteLength(fullText)
    const compactBytes = byteLength(compactText)

    if (usedBytes + fullBytes <= maxBytes) {
      items.push({ ...item, text: fullText, bytes: fullBytes, compact: false })
      usedBytes += fullBytes
      continue
    }

    if (usedBytes + compactBytes <= maxBytes) {
      items.push({ ...item, text: compactText, bytes: compactBytes, compact: true })
      usedBytes += compactBytes
    }
  }

  return { items, scored, usedBytes }
}

function renderRetrievedMemorySection(retrievedArtifacts) {
  if (!retrievedArtifacts?.length) return []
  const lines = []
  lines.push("## Retrieved session memory")
  lines.push("- Selected because these older artifacts match the current query more strongly than age alone would suggest.")
  lines.push("")
  for (const item of retrievedArtifacts) {
    lines.push(item.text.trimEnd())
  }
  return lines
}

function getWorktreeCacheDir(oracleHomeDir, worktree) {
  const resolvedWorktree = path.resolve(worktree || process.cwd())
  const rootDir = oracleHomeDir || path.join(os.homedir(), ".oracle")
  return path.join(rootDir, "opencode-memory", stableHash(resolvedWorktree))
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function writeJsonIfChanged(filePath, value) {
  const nextText = `${JSON.stringify(value, null, 2)}\n`
  if (existsSync(filePath)) {
    try {
      if (readFileSync(filePath, "utf8") === nextText) return false
    } catch {
      // fall through
    }
  }
  writeFileSync(filePath, nextText)
  return true
}

function persistSessionArtifacts({ oracleHomeDir, worktree, sessionArtifacts }) {
  const cacheDir = getWorktreeCacheDir(oracleHomeDir, worktree)
  const sessionsDir = path.join(cacheDir, "sessions")
  mkdirSync(sessionsDir, { recursive: true })

  let writes = 0
  for (const artifact of sessionArtifacts) {
    if (writeJsonIfChanged(path.join(sessionsDir, `${artifact.sessionId}.json`), artifact)) {
      writes += 1
    }
  }

  const manifestPath = path.join(cacheDir, "manifest.json")
  const previousManifest = readJsonIfExists(manifestPath)
  const manifest = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    worktree: path.resolve(worktree || process.cwd()),
    updatedAt: new Date().toISOString(),
    sessionCount: sessionArtifacts.length,
    sessions: sessionArtifacts.map((artifact) => ({
      sessionId: artifact.sessionId,
      title: artifact.title,
      sourceFingerprint: artifact.sourceFingerprint,
      messageCount: artifact.messageIds.length,
    })),
  }

  if (
    previousManifest?.schemaVersion === manifest.schemaVersion &&
    JSON.stringify(previousManifest.sessions) === JSON.stringify(manifest.sessions)
  ) {
    manifest.updatedAt = previousManifest.updatedAt
  }

  writeJsonIfChanged(manifestPath, manifest)

  return {
    cacheDir,
    manifestPath,
    sessionCount: sessionArtifacts.length,
    writes,
  }
}

export {
  MEMORY_SCHEMA_VERSION,
  buildQueryProfile,
  byteLength,
  buildStructuredMemorySection,
  getWorktreeCacheDir,
  loadCachedSessionArtifacts,
  makeSessionArtifact,
  mergeSessionArtifacts,
  persistSessionArtifacts,
  renderRetrievedMemorySection,
  scoreSessionArtifact,
  selectRetrievedArtifacts,
}
