#!/usr/bin/env node
//
// Prepare the local whisper.cpp decoder for the composer's voice button.
//
// Downloads two things into the voice data directory:
//   1. `whisper-cli` — the official prebuilt binary from ggml-org/whisper.cpp
//   2. `ggml-base.bin` — the multilingual base model from Hugging Face
//
// The directory is the same one `commands/voice.rs::voice_data_dir()` reads:
//   $CODEG_DATA_DIR/voice  (server mode / explicit override)
//   <user data dir>/codeg/voice  (desktop default)
//
// Safety / offline notes:
//   - Already-present files are never overwritten. Re-run with --force to
//     replace them.
//   - `CODEG_WHISPER_BIN` / `CODEG_WHISPER_MODEL` env overrides are honoured
//     by the app at runtime, so a system-installed decoder needs no download.
//   - Set `HF_ENDPOINT` to use a Hugging Face mirror in restricted networks.
//   - Set `CODEG_SKIP_WHISPER=1` to no-op (mirrors prepare-sidecars.mjs).
//
// Intentionally Node-only and shell-free so it runs on Windows, macOS and
// Linux GitHub runners alike.

import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  createWriteStream,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, basename } from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import process from "node:process"

// The rolling build tag carries prebuilt binaries; stable tags (v1.9.x) do
// not. Pinned so a release cannot silently swap the decoder underneath us.
const WHISPER_RELEASE = process.env.CODEG_WHISPER_RELEASE || "b5454"
const MODEL_NAME = process.env.CODEG_WHISPER_MODEL_NAME || "ggml-base.bin"
const MODEL_URL =
  process.env.HF_ENDPOINT ||
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`
const BIN_API = `https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/${WHISPER_RELEASE}`

function log(msg) {
  console.log(`[prepare-whisper] ${msg}`)
}
function die(msg) {
  console.error(`[prepare-whisper][ERROR] ${msg}`)
  process.exit(1)
}

function voiceDir() {
  if (process.env.CODEG_DATA_DIR) {
    return join(process.env.CODEG_DATA_DIR, "voice")
  }
  // Mirror Rust's dirs::data_dir(): XDG_DATA_HOME on Linux, ~/Library/Application
  // Support on macOS, %APPDATA% on Windows.
  if (process.platform === "win32") {
    const appdata =
      process.env.APPDATA ||
      join(process.env.USERPROFILE || tmpdir(), "AppData", "Roaming")
    return join(appdata, "codeg", "voice")
  }
  if (process.platform === "darwin") {
    return join(
      process.env.HOME || tmpdir(),
      "Library",
      "Application Support",
      "codeg",
      "voice"
    )
  }
  return join(
    process.env.XDG_DATA_HOME ||
      join(process.env.HOME || tmpdir(), ".local", "share"),
    "codeg",
    "voice"
  )
}

function binaryAsset() {
  const win = process.platform === "win32"
  const arm = process.arch === "arm64"
  if (win) return arm ? "whisper-bin-win-cpu-arm64.zip" : "whisper-bin-x64.zip"
  if (process.platform === "linux") {
    return arm
      ? "whisper-bin-ubuntu-arm64.tar.gz"
      : "whisper-bin-ubuntu-x64.tar.gz"
  }
  // macOS ships no prebuilt CLI in these releases; users install via brew or
  // build from source, then point CODEG_WHISPER_BIN at it.
  return null
}

async function download(url, dest) {
  log(`downloading ${url}`)
  const res = await fetch(url, {
    headers: { "user-agent": "codeg-prepare-whisper" },
    redirect: "follow",
  })
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`)
  if (!res.body) throw new Error(`${url} returned no body`)
  // Node's fetch returns a web ReadableStream; bridge it into Node streams.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

function extract(archive, into) {
  mkdirSync(into, { recursive: true })
  if (archive.endsWith(".zip")) {
    if (process.platform === "win32") {
      // PowerShell is available on every supported Windows runner.
      const result = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`,
        ],
        { stdio: "inherit" }
      )
      if (result.status !== 0) throw new Error("Expand-Archive failed")
    } else {
      execFileSync("unzip", ["-o", archive, "-d", into], { stdio: "inherit" })
    }
  } else {
    execFileSync("tar", ["-xzf", archive, "-C", into], { stdio: "inherit" })
  }
}

function findCli(root) {
  const wanted =
    process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (entry === wanted) return full
      try {
        if (statSync(full).isDirectory()) stack.push(full)
      } catch {
        // broken symlink — ignore
      }
    }
  }
  return null
}

async function main() {
  if (process.env.CODEG_SKIP_WHISPER === "1") {
    log("CODEG_SKIP_WHISPER=1 — skipping whisper preparation")
    return
  }
  const force = process.argv.includes("--force")
  const dir = voiceDir()
  mkdirSync(dir, { recursive: true })
  const cliName =
    process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"
  const cliDest = join(dir, cliName)
  const modelDest = join(dir, MODEL_NAME)

  // 1. Decoder binary. An env override means the user manages it; skip.
  if (existsSync(cliDest) && !force) {
    log(`decoder already present at ${cliDest}`)
  } else if (process.env.CODEG_WHISPER_BIN) {
    log(`CODEG_WHISPER_BIN set — using ${process.env.CODEG_WHISPER_BIN}`)
  } else {
    const asset = binaryAsset()
    if (!asset) {
      log(
        "no prebuilt CLI for this platform; set CODEG_WHISPER_BIN to your whisper-cli"
      )
    } else {
      const meta = await fetch(BIN_API, {
        headers: { "user-agent": "codeg-prepare-whisper" },
      })
      if (!meta.ok)
        throw new Error(`release lookup returned HTTP ${meta.status}`)
      const release = await meta.json()
      const found = (release.assets || []).find((a) => a.name === asset)
      if (!found)
        throw new Error(`asset ${asset} missing from ${WHISPER_RELEASE}`)
      const tmp = join(tmpdir(), `codeg-whisper-${Date.now()}`)
      mkdirSync(tmp, { recursive: true })
      const archive = join(tmp, basename(found.name))
      await download(found.browser_download_url, archive)
      extract(archive, tmp)
      const cli = findCli(tmp)
      if (!cli) throw new Error(`${asset} did not contain ${cliName}`)
      copyFileSync(cli, cliDest)
      if (process.platform !== "win32") chmodSync(cliDest, 0o755)
      log(`decoder staged at ${cliDest}`)
    }
  }

  // 2. Model. Same skip rules.
  if (existsSync(modelDest) && !force) {
    log(`model already present at ${modelDest}`)
  } else if (process.env.CODEG_WHISPER_MODEL) {
    log(`CODEG_WHISPER_MODEL set — using ${process.env.CODEG_WHISPER_MODEL}`)
  } else {
    const tmpModel = `${modelDest}.part`
    await download(MODEL_URL, tmpModel)
    copyFileSync(tmpModel, modelDest)
    writeFileSync(join(dir, "model-source.txt"), `${MODEL_URL}\n`)
    log(`model staged at ${modelDest}`)
  }

  log("done — voice input will use the local decoder on first use")
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)))
