#!/usr/bin/env node

import { mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

function resolvePluginsDir() {
  const args = process.argv.slice(2)
  const pluginsDirFlag = args.indexOf("--plugins-dir")
  if (pluginsDirFlag !== -1 && args[pluginsDirFlag + 1]) {
    return path.resolve(args[pluginsDirFlag + 1])
  }
  const opencodeDirFlag = args.indexOf("--opencode-dir")
  if (opencodeDirFlag !== -1 && args[opencodeDirFlag + 1]) {
    return path.resolve(args[opencodeDirFlag + 1], "plugins")
  }
  return path.join(os.homedir(), ".config", "opencode", "plugins")
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const pluginsDir = resolvePluginsDir()
const entryPoint = path.join(repoRoot, "examples", "opencode", "oracle-agent.js")
const outputFile = path.join(pluginsDir, "oracle-agent.js")

mkdirSync(pluginsDir, { recursive: true })

await build({
  entryPoints: [entryPoint],
  outfile: outputFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22"],
  external: ["@opencode-ai/plugin"],
  sourcemap: false,
  logLevel: "silent",
})

rmSync(path.join(pluginsDir, "oracle-agent-memory.js"), { force: true })
rmSync(path.join(pluginsDir, "oracle-agent.js.map"), { force: true })

process.stdout.write(`Bundled OpenCode bridge to ${outputFile}\n`)
process.stdout.write("The repo keeps split source files, but OpenCode now gets a single deployed plugin file.\n")
process.stdout.write("Oracle config lives in ~/.oracle/config.json; merge changes from examples/opencode/oracle-config.json5 when needed.\n")
