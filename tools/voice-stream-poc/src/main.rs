//! Throwaway validation harness for a streaming sherpa-onnx ASR engine.
//!
//! It does not touch the app's voice pipeline. It feeds a WAV into
//! `OnlineRecognizer` in realistic 100 ms chunks and reports:
//!   - the first non-empty partial and when it arrived,
//!   - every partial snapshot,
//!   - the final text,
//!   - decode-only real-time factor (RTF).
//!
//! Run from this directory:
//!   cargo run --release -- --model-dir models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23
//!
//! Add `--fast` to remove the simulated real-time sleep and measure pure
//! throughput instead of perceived latency.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig, Wave};

struct Args {
    model_dir: PathBuf,
    wav: Option<PathBuf>,
    chunk_ms: u32,
    realtime: bool,
}

fn usage() -> &'static str {
    "usage: voice-stream-poc [options]\n\
     \n\
     --model-dir <dir>   directory containing encoder/decoder/joiner/tokens\n\
     --wav <file>        WAV to transcribe (default: <model-dir>/test_wavs/0.wav)\n\
     --chunk-ms <n>      chunk size fed to the recognizer (default: 100)\n\
     --fast              do not sleep between chunks (throughput, not latency)\n\
     -h, --help          show this help"
}

fn parse_args() -> Result<Args, String> {
    let mut model_dir = PathBuf::from("models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23");
    let mut wav = None;
    let mut chunk_ms = 100u32;
    let mut realtime = true;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model-dir" => {
                model_dir = PathBuf::from(args.next().ok_or("--model-dir needs a value")?);
            }
            "--wav" => {
                wav = Some(PathBuf::from(args.next().ok_or("--wav needs a value")?));
            }
            "--chunk-ms" => {
                chunk_ms = args
                    .next()
                    .ok_or("--chunk-ms needs a value")?
                    .parse()
                    .map_err(|e| format!("invalid --chunk-ms: {e}"))?;
            }
            "--fast" => realtime = false,
            "-h" | "--help" => {
                println!("{}", usage());
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}\n\n{}", usage())),
        }
    }

    if chunk_ms == 0 || chunk_ms > 1000 {
        return Err("--chunk-ms must be between 1 and 1000".into());
    }

    Ok(Args {
        model_dir,
        wav,
        chunk_ms,
        realtime,
    })
}

fn first_file(dir: &Path, names: &[&str]) -> Result<PathBuf, String> {
    for name in names {
        let path = dir.join(name);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(format!("none of {:?} exists in {}", names, dir.display()))
}

fn printable(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn main() -> Result<(), String> {
    let args = parse_args()?;

    // Prefer int8: the 14M Chinese model is small enough for a product PoC,
    // and int8 is what we would ship if the accuracy holds.
    let encoder = first_file(
        &args.model_dir,
        &[
            "encoder-epoch-99-avg-1.int8.onnx",
            "encoder-epoch-99-avg-1.onnx",
            "encoder.int8.onnx",
            "encoder.onnx",
        ],
    )?;
    let decoder = first_file(
        &args.model_dir,
        &[
            "decoder-epoch-99-avg-1.int8.onnx",
            "decoder-epoch-99-avg-1.onnx",
            "decoder.onnx",
        ],
    )?;
    let joiner = first_file(
        &args.model_dir,
        &[
            "joiner-epoch-99-avg-1.int8.onnx",
            "joiner-epoch-99-avg-1.onnx",
            "joiner.int8.onnx",
            "joiner.onnx",
        ],
    )?;
    let tokens = first_file(&args.model_dir, &["tokens.txt"])?;

    let wav_path = args
        .wav
        .clone()
        .unwrap_or_else(|| args.model_dir.join("test_wavs").join("0.wav"));
    let wave = Wave::read(&printable(&wav_path))
        .ok_or_else(|| format!("cannot read WAV: {}", wav_path.display()))?;

    let mut config = OnlineRecognizerConfig::default();
    config.model_config.transducer.encoder = Some(printable(&encoder));
    config.model_config.transducer.decoder = Some(printable(&decoder));
    config.model_config.transducer.joiner = Some(printable(&joiner));
    config.model_config.tokens = Some(printable(&tokens));
    config.model_config.num_threads = 2;
    config.model_config.provider = Some("cpu".to_string());
    config.model_config.debug = false;
    config.enable_endpoint = true;
    config.decoding_method = Some("greedy_search".to_string());

    let load_started = Instant::now();
    let recognizer = OnlineRecognizer::create(&config)
        .ok_or_else(|| "OnlineRecognizer::create failed (check the model files)".to_string())?;
    let load_time = load_started.elapsed();
    let stream = recognizer.create_stream();

    let sample_rate = wave.sample_rate();
    let samples = wave.samples();
    let audio_seconds = samples.len() as f32 / sample_rate as f32;
    let chunk_samples = ((sample_rate as u64 * args.chunk_ms as u64) / 1000) as usize;
    let chunk_samples = chunk_samples.max(1);

    println!("model dir : {}", args.model_dir.display());
    println!("wav       : {}", wav_path.display());
    println!(
        "audio     : {:.2}s, {} Hz, chunk {} ms ({} samples)",
        audio_seconds, sample_rate, args.chunk_ms, chunk_samples
    );
    println!(
        "mode      : {}",
        if args.realtime {
            "real-time pacing (latency includes audio wait)"
        } else {
            "--fast (decode throughput only)"
        }
    );
    println!("model load: {:.0} ms", load_time.as_secs_f64() * 1000.0);
    println!();

    let started = Instant::now();
    let mut decode_time = Duration::ZERO;
    let mut first_partial_at = None;
    let mut last_text = String::new();
    let mut partials = 0usize;

    for chunk in samples.chunks(chunk_samples) {
        let decode_started = Instant::now();
        stream.accept_waveform(sample_rate, chunk);
        while recognizer.is_ready(&stream) {
            recognizer.decode(&stream);
        }
        decode_time += decode_started.elapsed();

        if let Some(result) = recognizer.get_result(&stream) {
            let text = result.text.trim().to_string();
            if !text.is_empty() && text != last_text {
                if first_partial_at.is_none() {
                    first_partial_at = Some(started.elapsed());
                }
                partials += 1;
                println!(
                    "[+{:>6.0} ms] {}",
                    started.elapsed().as_secs_f64() * 1000.0,
                    text
                );
                last_text = text;
            }
        }

        if args.realtime {
            std::thread::sleep(Duration::from_millis(args.chunk_ms as u64));
        }
    }

    stream.input_finished();
    let flush_started = Instant::now();
    while recognizer.is_ready(&stream) {
        recognizer.decode(&stream);
    }
    decode_time += flush_started.elapsed();

    let final_text = recognizer
        .get_result(&stream)
        .map(|r| r.text.trim().to_string())
        .unwrap_or_default();

    println!();
    println!("final     : {final_text}");
    if let Some(first) = first_partial_at {
        println!(
            "first partial after: {:.0} ms",
            first.as_secs_f64() * 1000.0
        );
    } else {
        println!("first partial after: (never)");
    }
    println!(
        "decode only: {:.0} ms, RTF {:.3}, partials {}",
        decode_time.as_secs_f64() * 1000.0,
        decode_time.as_secs_f32() / audio_seconds.max(0.001),
        partials
    );
    println!(
        "wall total : {:.0} ms",
        started.elapsed().as_secs_f64() * 1000.0
    );

    Ok(())
}
