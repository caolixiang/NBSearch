#!/usr/bin/env node

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, basename, resolve } from "node:path"

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith("--")) continue
    const value = argv[i + 1]
    args[key.slice(2)] = value
    i += 1
  }
  return args
}

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      files.push(...walk(full))
    } else {
      files.push(full)
    }
  }
  return files
}

function normalizeBaseUrl(value) {
  return value.replace(/\/$/, "")
}

const args = parseArgs(process.argv)
const version = (args.version || "").trim()
const pubDate = (args["pub-date"] || new Date().toISOString()).trim()
const repo = (args.repo || "").trim()
const tag = (args.tag || "").trim()
const artifactsDir = resolve(args["artifacts-dir"] || "release-artifacts")
const outPath = resolve(args.out || join(artifactsDir, "latest.json"))
const baseUrlArg = (args["base-url"] || "").trim()

if (!version) {
  throw new Error("Missing --version")
}

const metadataFiles = walk(artifactsDir).filter((file) => basename(file) === "updater-platform.json")
if (metadataFiles.length === 0) {
  throw new Error(`No updater-platform.json found under ${artifactsDir}`)
}

const platforms = {}
for (const file of metadataFiles) {
  const parsed = JSON.parse(readFileSync(file, "utf8"))
  if (!parsed.target || !parsed.bundle || !parsed.signature) {
    throw new Error(`Invalid updater metadata: ${file}`)
  }
  const url = baseUrlArg
    ? `${normalizeBaseUrl(baseUrlArg)}/${parsed.bundle}`
    : `https://github.com/${repo}/releases/download/${tag}/${parsed.bundle}`
  platforms[parsed.target] = {
    signature: String(parsed.signature).trim(),
    url,
  }
}

const manifest = {
  version,
  pub_date: pubDate,
  notes: "",
  platforms,
}

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Wrote updater manifest: ${outPath}`)
