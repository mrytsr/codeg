# voice-stream-poc

Standalone validation harness for a **streaming** local ASR engine based on
`sherpa-onnx`. It is intentionally outside `src-tauri` so it cannot affect the
desktop or server build.

It answers two questions before we touch the composer:

1. Can the small Chinese streaming model produce usable text for short prompts?
2. How soon does the first partial appear, and what is the decode RTF?

## 1. Download the model

From this directory (Git Bash / macOS / Linux):

```bash
mkdir -p models
curl -L -o models/model.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2
tar -xf models/model.tar.bz2 -C models
rm models/model.tar.bz2
```

The archive contains the int8 and fp32 variants plus `test_wavs/0.wav`.
The harness prefers the int8 files.

Expected directory:

```text
models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/
  encoder-epoch-99-avg-1.int8.onnx
  decoder-epoch-99-avg-1.int8.onnx
  joiner-epoch-99-avg-1.int8.onnx
  tokens.txt
  test_wavs/0.wav
```

## 2. Run

```bash
cargo run --release -- \
  --model-dir models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23
```

Useful variants:

```bash
# feed your own 16 kHz mono WAV
cargo run --release -- --model-dir models/... --wav /path/to/16k.wav

# 160 ms chunks (lower CPU, a bit more latency)
cargo run --release -- --model-dir models/... --chunk-ms 160

# no real-time sleep: measure pure decode throughput
cargo run --release -- --model-dir models/... --fast
```

The output reports:

- every partial transcript change with a timestamp
- first-partial latency
- final transcript
- decode-only time and RTF
- total wall time

`RTF < 1` means the decoder runs faster than real time.

## 3. Measured on this machine

Windows x64, CPU, `num_threads = 2`, Chinese `zipformer-zh-14M` int8:

| Metric | Result |
|---|---|
| Model size (int8 encoder/decoder/joiner + tokens) | 24.2 MB |
| Release binary with static sherpa-onnx | 17.8 MB |
| Model load (`OnlineRecognizer::create`) | 1.4–1.7 s |
| First partial, 100 ms chunks, real-time pacing | 0.73 s |
| First partial, 160 ms chunks, real-time pacing | 0.66 s |
| Decode only, 5.6 s audio | 0.13–0.21 s |
| RTF | 0.026–0.038 |

Sample output (`test_wavs/0.wav`):

```text
[+ 730 ms] 对
[+1041 ms] 对我做
[+1353 ms] 对我做了介绍
...
final     : 对我做了介绍那么我想说的是大家如果对我的研究感兴趣呢
```

`test_wavs/1.wav` also produced a coherent transcript:

```text
final     : 重点呢想谈三个问题首先呢就是这一轮全球金融动量的表现
```

This is a smoke test, not an accuracy benchmark: two official samples,
one machine, no manual word-level ground truth. The useful signals are the
model size, the first-partial latency and the RTF headroom.

The 1.5 s model load is the one number that affects UX directly: preload the
recognizer when the composer mounts (or on first focus), not on the first
microphone click, otherwise the user pays that delay before the mic starts.

## 4. Build / CI notes

`sherpa-onnx` 2.x statically links prebuilt native libraries; its build script
downloads the archive for the host target from GitHub. If the build machine
cannot reach GitHub, pre-download the `*-static-lib.tar.bz2` for the target and
point the build script at it:

```bash
export SHERPA_ONNX_ARCHIVE_DIR=/path/to/pre-downloaded-archives
```

For the actual product integration, keep this crate out of the release build
until the PoC results justify the model size, binary growth and packaging work.

## 5. Status: shipped

The streaming path this harness validated is now the formal module
`src-tauri/src/commands/voice_stream.rs` (zh/en locales stream live partials
via `voice://partial`; every other locale keeps the whisper batch path). The
model download is automatic in-app, and the measurements above are what the
product's prepare/start/chunk/stop design is based on. This harness stays a
standalone crate for latency regressions and model comparisons.
