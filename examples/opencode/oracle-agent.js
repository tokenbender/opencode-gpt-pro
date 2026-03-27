import { tool } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const MAX_TEXT_CHARS = parsePositiveInt(process.env.ORACLE_OPENCODE_MAX_TEXT_CHARS, 40000)
const MAX_TOOL_OUTPUT_CHARS = parsePositiveInt(process.env.ORACLE_OPENCODE_MAX_TOOL_OUTPUT_CHARS, 12000)
const MAX_JSON_CHARS = parsePositiveInt(process.env.ORACLE_OPENCODE_MAX_JSON_CHARS, 4000)
const MAX_CONTEXT_FILE_BYTES = parsePositiveInt(process.env.ORACLE_OPENCODE_MAX_CONTEXT_FILE_BYTES, 900 * 1024)
const FULL_TRANSCRIPT_SESSION_COUNT = parsePositiveInt(
  process.env.ORACLE_OPENCODE_FULL_TRANSCRIPT_SESSIONS,
  1,
)
const COMPACT_TRANSCRIPT_SESSION_COUNT = parsePositiveInt(
  process.env.ORACLE_OPENCODE_COMPACT_TRANSCRIPT_SESSIONS,
  2,
)

const COMPACT_MESSAGE_RENDER_OPTIONS = {
  includeToolInputs: false,
  includeToolOutputs: false,
  maxJsonChars: 1200,
  maxSubtaskPromptChars: 6000,
  maxTextChars: 12000,
}

const SUMMARY_MESSAGE_RENDER_OPTIONS = {
  includeSubtaskPrompt: false,
  includeToolAttachments: false,
  includeToolInputs: false,
  includeToolOutputs: false,
  maxJsonChars: 600,
  maxSubtaskPromptChars: 1200,
  maxTextChars: 2500,
}

function unwrap(result) {
  if (result && typeof result === "object" && "data" in result) {
    return result.data
  }
  return result
}

function truncate(text, max) {
  if (!text) return ""
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} characters]`
}

function byteLength(text) {
  return Buffer.byteLength(text ?? "", "utf8")
}

function formatBytes(size) {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(1).replace(/\.0$/, "")} KB`
  }
  return `${size} B`
}

function safeJson(value, max = MAX_JSON_CHARS) {
  try {
    return truncate(JSON.stringify(value, null, 2), max)
  } catch {
    return "[unserializable value]"
  }
}

function relPath(targetPath, worktree) {
  if (!targetPath) return ""
  if (!worktree) return targetPath
  const relative = path.relative(worktree, targetPath)
  if (!relative || relative.startsWith("..")) return targetPath
  return relative
}

function decodeFileUrl(url) {
  if (!url || !url.startsWith("file://")) return null
  try {
    return fileURLToPath(url)
  } catch {
    return null
  }
}

function resolveExistingPath(candidate, directory, worktree) {
  if (!candidate || typeof candidate !== "string") return null
  const absoluteCandidates = []
  if (path.isAbsolute(candidate)) {
    absoluteCandidates.push(candidate)
  } else {
    absoluteCandidates.push(path.resolve(directory, candidate))
    if (worktree && worktree !== directory) {
      absoluteCandidates.push(path.resolve(worktree, candidate))
    }
  }
  for (const value of absoluteCandidates) {
    if (existsSync(value)) return value
  }
  return null
}

function describeFilePart(part, worktree) {
  const source = part.source
  if (source?.path) {
    return relPath(source.path, worktree)
  }
  const fileFromUrl = decodeFileUrl(part.url)
  if (fileFromUrl) {
    return relPath(fileFromUrl, worktree)
  }
  if (part.filename) {
    return part.filename
  }
  return part.url
}

function renderToolPart(part, worktree, options = {}) {
  const {
    includeAttachments = true,
    includeInput = true,
    includeOutput = true,
    maxInputChars = MAX_JSON_CHARS,
    maxOutputChars = MAX_TOOL_OUTPUT_CHARS,
  } = options
  const lines = []
  const state = part.state
  lines.push(`[tool:${part.tool}] status=${state.status}`)
  if (state.title) lines.push(`title: ${state.title}`)
  if (includeInput && state.input && Object.keys(state.input).length > 0) {
    lines.push(`input:\n${safeJson(state.input, maxInputChars)}`)
  }
  if (state.status === "completed") {
    if (includeOutput && state.output) {
      lines.push(`output:\n${truncate(state.output, maxOutputChars)}`)
    }
    if (includeAttachments && state.attachments?.length) {
      lines.push(
        `attachments: ${state.attachments.map((item) => describeFilePart(item, worktree)).join(", ")}`,
      )
    }
  }
  if (state.status === "error") {
    lines.push(`error:\n${truncate(state.error, maxOutputChars)}`)
  }
  return lines.join("\n")
}

function renderMessage(entry, worktree, options = {}) {
  const {
    includeSubtaskPrompt = true,
    includeToolAttachments = true,
    includeToolInputs = true,
    includeToolOutputs = true,
    maxJsonChars = MAX_JSON_CHARS,
    maxSubtaskPromptChars = MAX_TEXT_CHARS,
    maxTextChars = MAX_TEXT_CHARS,
    maxToolOutputChars = MAX_TOOL_OUTPUT_CHARS,
  } = options
  const { info, parts } = entry
  const lines = []
  lines.push(`### ${info.role.toUpperCase()} ${info.id}`)
  if (info.role === "user") {
    lines.push(`agent: ${info.agent}`)
    lines.push(`model: ${info.model.providerID}/${info.model.modelID}`)
    if (info.summary?.title) lines.push(`summary title: ${info.summary.title}`)
    if (info.summary?.body) lines.push(`summary body: ${info.summary.body}`)
    if (info.summary?.diffs?.length) {
      lines.push(
        `summary diffs: ${info.summary.diffs
          .map((diff) => `${diff.file} (+${diff.additions}/-${diff.deletions})`)
          .join(", ")}`,
      )
    }
  }
  if (info.role === "assistant") {
    lines.push(`provider/model: ${info.providerID}/${info.modelID}`)
    lines.push(`mode: ${info.mode}`)
    if (info.finish) lines.push(`finish: ${info.finish}`)
    if (info.error) {
      lines.push(`error: ${safeJson(info.error, maxJsonChars)}`)
    }
  }
  for (const part of parts) {
    switch (part.type) {
      case "text": {
        if (part.ignored) break
        lines.push(truncate(part.text, maxTextChars))
        break
      }
      case "subtask": {
        lines.push(`[subtask] agent=${part.agent} description=${part.description}`)
        if (includeSubtaskPrompt) {
          lines.push(`prompt:\n${truncate(part.prompt, maxSubtaskPromptChars)}`)
        }
        break
      }
      case "file": {
        lines.push(`[file] ${describeFilePart(part, worktree)}`)
        break
      }
      case "tool": {
        lines.push(
          renderToolPart(part, worktree, {
            includeAttachments: includeToolAttachments,
            includeInput: includeToolInputs,
            includeOutput: includeToolOutputs,
            maxInputChars: maxJsonChars,
            maxOutputChars: maxToolOutputChars,
          }),
        )
        break
      }
      case "patch": {
        lines.push(`[patch] files=${part.files.join(", ")}`)
        break
      }
      case "agent": {
        lines.push(`[agent] ${part.name}`)
        break
      }
      case "retry": {
        lines.push(`[retry] ${safeJson(part.error, MAX_JSON_CHARS)}`)
        break
      }
      case "compaction": {
        lines.push(`[compaction] auto=${part.auto}`)
        break
      }
      default:
        break
    }
  }
  return `${lines.join("\n")}\n`
}

function renderSessionBlock(session, entries, worktree, messageOptions) {
  const sections = []
  sections.push(`## Session ${session.id}`)
  sections.push(`- Directory: ${session.directory}`)
  sections.push(`- Title: ${session.title}`)
  sections.push(`- Parent: ${session.parentID ?? "<root>"}`)
  sections.push("")
  for (const entry of entries) {
    sections.push(renderMessage(entry, worktree, messageOptions))
  }
  return `${sections.join("\n")}\n`
}

function countSessionBlocks(blocks) {
  return blocks.reduce(
    (counts, block) => {
      counts[block.mode] += 1
      return counts
    },
    { compact: 0, full: 0, summary: 0 },
  )
}

function buildTranscriptNotes(blocks, omittedSessions) {
  const counts = countSessionBlocks(blocks)
  if (counts.compact === 0 && counts.full === 0 && counts.summary === 0 && omittedSessions === 0) {
    return []
  }
  if (counts.compact === 0 && counts.summary === 0 && omittedSessions === 0) {
    return []
  }
  const lines = []
  lines.push(`- Transcript budget: ${formatBytes(MAX_CONTEXT_FILE_BYTES)}.`)
  lines.push(
    `- Included ${counts.full} full, ${counts.compact} compact, and ${counts.summary} summary session blocks.`,
  )
  if (omittedSessions > 0) {
    lines.push(
      `- Omitted ${omittedSessions} older session${omittedSessions === 1 ? "" : "s"} to stay within the attachment limit.`,
    )
  }
  lines.push("")
  return lines
}

function selectTranscriptBlocks(lineage, lineageMessages, worktree, baseBytes) {
  const blocks = []
  let omittedSessions = 0
  let usedBytes = baseBytes

  for (let index = lineage.length - 1; index >= 0; index -= 1) {
    const session = lineage[index]
    const entries = lineageMessages.get(session.id) ?? []
    const rankFromNewest = lineage.length - 1 - index
    const candidates =
      rankFromNewest < FULL_TRANSCRIPT_SESSION_COUNT
        ? [
            ["full", undefined],
            ["compact", COMPACT_MESSAGE_RENDER_OPTIONS],
            ["summary", SUMMARY_MESSAGE_RENDER_OPTIONS],
          ]
        : rankFromNewest < FULL_TRANSCRIPT_SESSION_COUNT + COMPACT_TRANSCRIPT_SESSION_COUNT
          ? [
              ["compact", COMPACT_MESSAGE_RENDER_OPTIONS],
              ["summary", SUMMARY_MESSAGE_RENDER_OPTIONS],
            ]
          : [["summary", SUMMARY_MESSAGE_RENDER_OPTIONS]]

    let chosen = null
    for (const [mode, messageOptions] of candidates) {
      const text = renderSessionBlock(session, entries, worktree, messageOptions)
      if (usedBytes + byteLength(text) <= MAX_CONTEXT_FILE_BYTES) {
        chosen = { mode, text }
        break
      }
    }

    if (!chosen) {
      omittedSessions = index + 1
      break
    }

    blocks.push(chosen)
    usedBytes += byteLength(chosen.text)
  }

  blocks.reverse()
  return { blocks, omittedSessions }
}

function addResolvedPath(fileSet, candidate, directory, worktree) {
  const resolved = resolveExistingPath(candidate, directory, worktree)
  if (resolved) fileSet.add(resolved)
}

function collectFiles(messages, fileSet, directory, worktree) {
  for (const entry of messages) {
    if (entry.info.role === "user" && entry.info.summary?.diffs?.length) {
      for (const diff of entry.info.summary.diffs) {
        addResolvedPath(fileSet, diff.file, directory, worktree)
      }
    }
    for (const part of entry.parts) {
      if (part.type === "file") {
        if (part.source?.path) addResolvedPath(fileSet, part.source.path, directory, worktree)
        const fileFromUrl = decodeFileUrl(part.url)
        if (fileFromUrl) addResolvedPath(fileSet, fileFromUrl, directory, worktree)
      }
      if (part.type === "patch") {
        for (const file of part.files) addResolvedPath(fileSet, file, directory, worktree)
      }
      if (part.type === "tool" && part.state.status === "completed" && part.state.attachments?.length) {
        for (const attachment of part.state.attachments) {
          if (attachment.source?.path) addResolvedPath(fileSet, attachment.source.path, directory, worktree)
          const fileFromUrl = decodeFileUrl(attachment.url)
          if (fileFromUrl) addResolvedPath(fileSet, fileFromUrl, directory, worktree)
        }
      }
    }
  }
}

async function getSession(client, sessionID, directory) {
  return unwrap(
    await client.session.get({
      path: { id: sessionID },
      query: { directory },
    }),
  )
}

async function getSessionMessages(client, sessionID, directory) {
  return unwrap(
    await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    }),
  )
}

async function getSessionLineage(client, sessionID, directory) {
  const sessions = []
  const seen = new Set()
  let currentID = sessionID
  while (currentID && !seen.has(currentID)) {
    seen.add(currentID)
    const session = await getSession(client, currentID, directory)
    sessions.push(session)
    currentID = session.parentID
  }
  sessions.reverse()
  return sessions
}

async function runOracle(binary, args, cwd, abortSignal, env = process.env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: abortSignal,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", (error) => {
      reject(error)
    })
    child.on("close", (code) => {
      resolve({ code, stdout, stderr })
    })
  })
}

function buildContextMarkdown({ args, context, lineage, lineageMessages, attachedFiles }) {
  const sections = []
  sections.push("# OpenCode Oracle Bridge Context")
  sections.push("")
  sections.push("## User task")
  sections.push(args.prompt.trim())
  sections.push("")
  sections.push("## OpenCode execution context")
  sections.push(`- Current agent: ${context.agent}`)
  sections.push(`- Working directory: ${context.directory}`)
  sections.push(`- Worktree root: ${context.worktree}`)
  sections.push(`- Session lineage: ${lineage.map((session) => session.id).join(" -> ")}`)
  sections.push(`- Active message id: ${context.messageID}`)
  sections.push("")
  sections.push("## Attached local artifacts")
  if (attachedFiles.length) {
    for (const file of attachedFiles) {
      sections.push(`- ${relPath(file, context.worktree)}`)
    }
  } else {
    sections.push("- No local project artifacts were auto-detected beyond this context file.")
  }
  sections.push("")
  sections.push("## Guidance for Oracle")
  sections.push("- Treat this file as the authoritative OpenCode transcript/history bundle.")
  sections.push("- Use the separately attached project files as source of truth for current code and artifacts.")
  sections.push("- If the transcript conflicts with current files, prefer current files and call out the mismatch.")
  sections.push("- Use the conversation/tool history below when forming your answer.")
  sections.push("- Older sessions may be compacted or omitted to keep this attachment within the size budget.")
  sections.push("")

  const transcriptBaseSections = [...sections, "## Session transcript", ""]
  const { blocks: selectedBlocks, omittedSessions: initialOmittedSessions } = selectTranscriptBlocks(
    lineage,
    lineageMessages,
    context.worktree,
    byteLength(transcriptBaseSections.join("\n")),
  )

  let transcriptBlocks = selectedBlocks
  let omittedSessions = initialOmittedSessions
  let contextMarkdown = ""

  while (true) {
    const transcriptSections = [
      ...transcriptBaseSections,
      ...buildTranscriptNotes(transcriptBlocks, omittedSessions),
      ...transcriptBlocks.map((block) => block.text),
    ]
    contextMarkdown = transcriptSections.join("\n")
    if (byteLength(contextMarkdown) <= MAX_CONTEXT_FILE_BYTES || transcriptBlocks.length === 0) {
      break
    }
    transcriptBlocks = transcriptBlocks.slice(1)
    omittedSessions += 1
  }

  return contextMarkdown
}

async function OracleAgentPlugin({ client }) {
  const pluginDir = path.dirname(fileURLToPath(import.meta.url))
  const configDir = path.resolve(pluginDir, "..")
  const oracleHomeDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle")
  const oracleProfileDir =
    process.env.ORACLE_BROWSER_PROFILE_DIR ?? path.join(oracleHomeDir, "browser-profile")
  const oracleBinary = path.join(
    configDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "oracle.cmd" : "oracle",
  )

  return {
    tool: {
      oracle_consult: tool({
        description:
          "Consult steipete/oracle with the full OpenCode session lineage, transcript, tool outputs, and discovered file artifacts.",
        args: {
          prompt: tool.schema.string().describe("Question or task for Oracle."),
          files: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Optional extra file paths or glob patterns to attach."),
          model: tool.schema.string().optional().describe("Optional Oracle model override, such as gpt-5.4-pro."),
          engine: tool.schema.enum(["api", "browser"]).optional().describe("Optional Oracle engine override."),
        },
        async execute(args, context) {
          if (!existsSync(oracleBinary)) {
            throw new Error(
              `Oracle CLI is not installed at ${oracleBinary}. Run 'bun install' in ~/.config/opencode and restart OpenCode.`,
            )
          }

          const lineage = await getSessionLineage(client, context.sessionID, context.directory)
          const lineageMessages = new Map()
          const attachedFileSet = new Set()

          for (const session of lineage) {
            const messages = await getSessionMessages(client, session.id, context.directory)
            lineageMessages.set(session.id, messages)
            collectFiles(messages, attachedFileSet, context.directory, context.worktree)
          }

          const manualFiles = Array.isArray(args.files) ? args.files.filter(Boolean) : []
          const autoFiles = Array.from(attachedFileSet).sort()
          const tempDir = mkdtempSync(path.join(os.tmpdir(), "opencode-oracle-"))
          const contextFile = path.join(tempDir, "opencode-session-context.md")
          const outputFile = path.join(tempDir, "oracle-output.txt")
          const contextMarkdown = buildContextMarkdown({
            args,
            context,
            lineage,
            lineageMessages,
            attachedFiles: autoFiles,
          })

          writeFileSync(contextFile, contextMarkdown)

          const oracleArgs = [
            "--wait",
            "--browser-model-strategy",
            "current",
            "--write-output",
            outputFile,
            "--prompt",
            "Use the attached opencode-session-context.md transcript as the authoritative OpenCode history and answer the task described inside it. Use the other attached files as the current project/artifact source of truth.",
            "--file",
            contextFile,
          ]

          if (args.model) {
            oracleArgs.push("--model", args.model)
          }
          if (args.engine) {
            oracleArgs.push("--engine", args.engine)
          }

          for (const file of autoFiles) {
            oracleArgs.push("--file", file)
          }
          for (const file of manualFiles) {
            oracleArgs.push("--file", file)
          }

          context.metadata({
            title: `Consulting Oracle (${autoFiles.length + manualFiles.length + 1} files)`,
            metadata: {
              engine: args.engine ?? "auto",
              model: args.model ?? "default",
              browserProfileDir: oracleProfileDir,
              lineage: lineage.map((session) => session.id),
              files: autoFiles.map((file) => relPath(file, context.worktree)),
              manualFiles,
            },
          })

          try {
            mkdirSync(oracleProfileDir, { recursive: true })
            const result = await runOracle(oracleBinary, oracleArgs, context.directory, context.abort, {
              ...process.env,
              ORACLE_HOME_DIR: oracleHomeDir,
              ORACLE_BROWSER_PROFILE_DIR: oracleProfileDir,
            })
            if (result.code !== 0) {
              const details = truncate(`${result.stderr || result.stdout}`.trim(), MAX_TOOL_OUTPUT_CHARS)
              throw new Error(
                [
                  "Oracle run failed.",
                  details || "No CLI output was captured.",
                  "If this is your first browser run, initialize the profile with ~/.config/opencode/oracle-login.sh.",
                ].join("\n\n"),
              )
            }

            if (!existsSync(outputFile)) {
              const details = truncate(`${result.stderr || result.stdout}`.trim(), MAX_TOOL_OUTPUT_CHARS)
              throw new Error(
                [
                  "Oracle completed without producing an output file.",
                  details || "No CLI output was captured.",
                ].join("\n\n"),
              )
            }

            const finalOutput = readFileSync(outputFile, "utf8").trim()
            if (!finalOutput) {
              const details = truncate(`${result.stderr || result.stdout}`.trim(), MAX_TOOL_OUTPUT_CHARS)
              throw new Error(
                [
                  "Oracle returned an empty response.",
                  details || "No CLI output was captured.",
                ].join("\n\n"),
              )
            }

            return finalOutput
          } finally {
            rmSync(tempDir, { recursive: true, force: true })
          }
        },
      }),
    },
  }
}

export default OracleAgentPlugin
export { OracleAgentPlugin }
