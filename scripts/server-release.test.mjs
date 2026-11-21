// Regression tests for the parts of the release workflows this repo
// cherry-picked from the YoYoCode voice-input port: the sherpa-onnx native
// archive cache wiring and the macOS microphone/signing configuration.
// Fork-specific PLUS-identity and packaging tests are not carried over.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { parse } from "yaml"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workflow = parse(
  readFileSync(join(root, ".github/workflows/release.yml"), "utf8")
)
const server = workflow.jobs["build-server"]
const desktop = workflow.jobs["build-tauri"]
const rustTests = parse(
  readFileSync(join(root, ".github/workflows/test.yml"), "utf8")
).jobs.rust

const sherpaPlatforms = [
  ["x86_64-unknown-linux-gnu", "Linux", "X64", "linux-x64-static-lib"],
  ["aarch64-unknown-linux-gnu", "Linux", "ARM64", "linux-aarch64-static-lib"],
  ["x86_64-apple-darwin", "macOS", "X64", "osx-x64-static-lib"],
  ["aarch64-apple-darwin", "macOS", "ARM64", "osx-arm64-static-lib"],
  ["x86_64-pc-windows-msvc", "Windows", "X64", "win-x64-static-MT-Release-lib"],
  [
    "aarch64-pc-windows-msvc",
    "Windows",
    "ARM64",
    "win-arm64-static-MT-Release-lib",
  ],
]

for (const [label, job] of [
  ["desktop release", desktop],
  ["server release", server],
  ["Rust tests", rustTests],
]) {
  test(`${label} exports the cached native archive to the sherpa build script`, (t) => {
    const resolveStep = job.steps.find((entry) =>
      entry.name?.startsWith("Resolve sherpa-onnx native archive")
    )
    const cacheStep = job.steps.find(
      (entry) => entry.name === "Cache sherpa-onnx native archive"
    )
    assert.ok(resolveStep)
    assert.ok(cacheStep)

    for (const [target, os, arch, archive] of sherpaPlatforms) {
      if (
        job.strategy.matrix.include?.some((entry) => entry.target) &&
        !job.strategy.matrix.include.some((entry) => entry.target === target)
      )
        continue

      const dir = scratch(t)
      const runnerTemp = join(dir, "runner temp").replaceAll("\\", "/")
      const envFile = join(dir, "github-env").replaceAll("\\", "/")
      const archiveDir = `${runnerTemp}/sherpa-onnx`
      const archiveName = `sherpa-onnx-v2.0.1-${archive}.tar.bz2`
      mkdirSync(archiveDir, { recursive: true })
      writeFileSync(join(archiveDir, archiveName), "cached native library")
      writeFileSync(envFile, "")
      run(
        "bash",
        [
          "-e",
          "-o",
          "pipefail",
          "-c",
          resolveStep.run.replaceAll("${{ matrix.target }}", target),
        ],
        dir,
        {
          RUNNER_OS: os,
          RUNNER_ARCH: arch,
          RUNNER_TEMP: runnerTemp,
          GITHUB_ENV: envFile,
          SHERPA_ONNX_ARCHIVE_DIR: "",
        }
      )
      const exported = Object.fromEntries(
        readFileSync(envFile, "utf8")
          .trim()
          .split(/\r?\n/)
          .map((line) => {
            const equals = line.indexOf("=")
            return [line.slice(0, equals), line.slice(equals + 1)]
          })
      )
      assert.ok(
        exported.SHERPA_ONNX_ARCHIVE_DIR,
        `${target}: sherpa cannot see the cached archive`
      )
      assert.equal(
        readFileSync(
          join(exported.SHERPA_ONNX_ARCHIVE_DIR, archiveName),
          "utf8"
        ),
        "cached native library"
      )
      assert.equal(exported.SHERPA_ARCHIVE_NAME, archiveName)
      const cachePath = cacheStep.with.path
        .replaceAll("${{ runner.temp }}", runnerTemp)
        .replace(/\$\{\{ env\.(\w+) \}\}/g, (_, key) => exported[key] ?? "")
      assert.equal(
        resolve(cachePath),
        resolve(exported.SHERPA_ONNX_ARCHIVE_DIR)
      )
    }
  })
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "codeg-release-test-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "", ...env },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout
}

test("macOS release declares microphone use and signs the main app for audio input", () => {
  const { infoPlist } = JSON.parse(
    readFileSync(join(root, "src-tauri/tauri.macos.conf.json"), "utf8")
  ).bundle.macOS
  assert.ok(infoPlist, "macOS bundle needs a microphone usage description")
  assert.match(
    readFileSync(join(root, "src-tauri", infoPlist), "utf8"),
    /<key>NSMicrophoneUsageDescription<\/key>\s*<string>\s*[^<\s][^<]*<\/string>/
  )

  const macosBuild = desktop.steps.find((entry) =>
    entry.name?.startsWith("Build, sign, and upload to draft release (macOS)")
  )
  const configPath = macosBuild?.with.args.match(/--config\s+(\S+)/)?.[1]
  assert.ok(configPath, "macOS release needs a signing configuration")
  const { bundle } = JSON.parse(readFileSync(join(root, configPath), "utf8"))
  assert.deepEqual(bundle.externalBin, [], "sidecars are signed separately")
  for (const name of ["codeg-mcp", "codeg-cli"]) {
    assert.ok(
      bundle.macOS.files[`MacOS/${name}`],
      `${name} must remain beside the main executable`
    )
  }
  const entitlementPlist = readFileSync(
    join(root, "src-tauri", bundle.macOS.entitlements),
    "utf8"
  )
  assert.match(
    entitlementPlist,
    /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/
  )
  assert.equal(entitlementPlist.match(/<key>/g)?.length, 1)
})

test("macOS release stages sidecars at their configured bundle source paths", (t) => {
  const stage = desktop.steps.find(
    (entry) => entry.name === "Stage signed macOS sidecars"
  )
  assert.ok(stage)
  const macosBuild = desktop.steps.find((entry) =>
    entry.name?.startsWith("Build, sign, and upload to draft release (macOS)")
  )
  const configPath = macosBuild.with.args.match(/--config\s+(\S+)/)[1]
  const { bundle } = JSON.parse(readFileSync(join(root, configPath), "utf8"))

  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const dir = scratch(t)
    const bins = join(dir, "src-tauri/binaries")
    mkdirSync(bins, { recursive: true })
    for (const name of ["codeg-mcp", "codeg-cli"]) {
      writeFileSync(join(bins, `${name}-${target}`), `${target}:${name}`)
    }
    // Only replace the unavailable macOS signing binary. Run the actual
    // workflow copy commands, then inspect the files the bundler will consume.
    const script =
      'codesign() { printf "%s\\n" "$*" >> signatures.log; }\n' + stage.run
    run("bash", ["-e", "-c", script], dir, {
      BUILD_TARGET: target,
      APPLE_SIGNING_IDENTITY: "Developer ID Application: codeg",
    })
    for (const name of ["codeg-mcp", "codeg-cli"]) {
      const source = bundle.macOS.files[`MacOS/${name}`]
      assert.equal(
        readFileSync(join(dir, "src-tauri", source), "utf8"),
        `${target}:${name}`
      )
    }
    const signatures = readFileSync(join(dir, "signatures.log"), "utf8")
      .trim()
      .split(/\r?\n/)
    assert.deepEqual(signatures, [
      "--force --options runtime --timestamp --sign Developer ID Application: codeg src-tauri/binaries/macos-release/codeg-mcp",
      "--force --options runtime --timestamp --sign Developer ID Application: codeg src-tauri/binaries/macos-release/codeg-cli",
    ])
  }
})
