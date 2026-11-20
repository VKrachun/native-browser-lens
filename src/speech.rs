//! Local transcription. Whisper large-v3-turbo runs in `lens-speech`, a separate program next to
//! Lens: a GPU build first (Vulkan or Metal), then the CPU build. whisper.cpp is C++, so a crash
//! there ends that process, never the daemon. The models download once, after the person agrees,
//! from pinned revisions, and each file must match its pinned SHA-256.
use crate::paths::Paths;
use crate::protocol::{ModelState, SpeechStatus, VoiceSegment};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct ModelFile {
    pub file: &'static str,
    url: &'static str,
    sha256: &'static str,
    pub size: u64,
}

pub const MODEL_NAME: &str = "Whisper large-v3-turbo";

/// whisper.cpp's large-v3-turbo, quantized to 5 bits: close to large-v3 in quality, and fast
/// enough for long sessions on a GPU.
pub const WHISPER: ModelFile = ModelFile {
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    size: 574_041_195,
};

/// Silero voice activity detection: finds the speech, so silence is never transcribed into
/// invented words and each part keeps its real time.
pub const VAD: ModelFile = ModelFile {
    file: "ggml-silero-v6.2.0.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin",
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    size: 885_098,
};

const FILES: [&ModelFile; 2] = [&WHISPER, &VAD];

/// `LENS_SPEECH_MODELS` points tests and development at models that are already on disk.
pub fn models_dir(paths: &Paths) -> PathBuf {
    std::env::var_os("LENS_SPEECH_MODELS")
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.data.join("models"))
}

/// Downloads finish with a hash check and an atomic rename, so a file of the right size is whole.
pub fn models_ready(paths: &Paths) -> bool {
    let dir = models_dir(paths);
    FILES
        .iter()
        .all(|m| std::fs::metadata(dir.join(m.file)).is_ok_and(|meta| meta.len() == m.size))
}

pub fn download_size() -> u64 {
    FILES.iter().map(|m| m.size).sum()
}

/// The status for the settings page. `download` is what an install in progress reports.
pub fn status(paths: &Paths, download: Option<&ModelState>) -> SpeechStatus {
    let model = match download {
        Some(state) => state.clone(),
        None if models_ready(paths) => ModelState::Ready,
        None => ModelState::Missing,
    };
    SpeechStatus {
        model,
        engines: engines()
            .into_iter()
            .map(|(_, label)| label.into())
            .collect(),
        model_name: MODEL_NAME.into(),
        download_bytes: download_size(),
    }
}

/// Fetches every missing model file. `progress` hears bytes received of the total.
pub fn download(paths: &Paths, progress: impl Fn(u64, u64)) -> Result<(), String> {
    let dir = models_dir(paths);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let total = download_size();
    let mut done = 0;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_global(Some(Duration::from_secs(4 * 3600)))
        .build()
        .into();
    for model in FILES {
        let target = dir.join(model.file);
        if std::fs::metadata(&target).is_ok_and(|m| m.len() == model.size) {
            done += model.size;
            progress(done, total);
            continue;
        }
        let partial = dir.join(format!("{}.part", model.file));
        let mut response = agent
            .get(model.url)
            .call()
            .map_err(|e| format!("cannot download {}: {e}", model.file))?;
        let mut reader = response
            .body_mut()
            .with_config()
            .limit(model.size + 1)
            .reader();
        let mut file = std::fs::File::create(&partial).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; 1 << 20];
        let mut received = 0u64;
        loop {
            let n = reader
                .read(&mut buffer)
                .map_err(|e| format!("the download of {} broke off: {e}", model.file))?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
            file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
            received += n as u64;
            progress(done + received, total);
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        let sha256: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if sha256 != model.sha256 || received != model.size {
            let _ = std::fs::remove_file(&partial);
            return Err(format!(
                "{} did not match its pinned hash; nothing was installed",
                model.file
            ));
        }
        std::fs::rename(&partial, &target).map_err(|e| e.to_string())?;
        done += model.size;
    }
    Ok(())
}

/// The speech programs Lens can run, best first. Release archives put them next to `lens`;
/// `LENS_SPEECH_DIR` points development builds at a target folder.
pub fn engines() -> Vec<(PathBuf, &'static str)> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("LENS_SPEECH_DIR")
        .map(PathBuf::from)
        .into_iter()
        .collect();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf))
    {
        dirs.push(dir);
    }
    let exe = std::env::consts::EXE_SUFFIX;
    let mut found = Vec::new();
    for (name, label) in [("lens-speech-gpu", "GPU"), ("lens-speech", "CPU")] {
        if let Some(path) = dirs
            .iter()
            .map(|d| d.join(format!("{name}{exe}")))
            .find(|p| p.is_file())
        {
            found.push((path, label));
        }
    }
    found
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub language: String,
    pub engine: String,
    pub segments: Vec<VoiceSegment>,
}

/// Transcribes a 16 kHz mono WAV with the best engine that works. A GPU build that cannot start
/// (no Vulkan driver, say) falls back to the CPU build.
pub fn transcribe(paths: &Paths, wav: &Path, duration_ms: i64) -> Result<Transcript, String> {
    let dir = models_dir(paths);
    let engines = engines();
    if engines.is_empty() {
        return Err("Lens cannot find its speech program (lens-speech) next to it".into());
    }
    let threads = std::thread::available_parallelism().map_or(4, |n| (n.get() / 2).max(2));
    // Generous: the CPU build runs at about real time on a slow machine.
    let limit = Duration::from_secs(600) + Duration::from_millis(duration_ms.max(0) as u64 * 3);
    let mut failures = Vec::new();
    for (program, label) in engines {
        let mut command = Command::new(&program);
        command
            .arg(dir.join(WHISPER.file))
            .arg(wav)
            .arg("--vad")
            .arg(dir.join(VAD.file))
            .args(["--threads", &threads.to_string()]);
        let (stdout, failure) = match run(command, limit, &paths.data.join("tmp")) {
            Ok(stdout) => (stdout, None),
            Err((e, stdout)) => (stdout, Some(e)),
        };
        // A complete answer counts even when the program crashed after it: GPU drivers can crash
        // in their exit handlers (NVIDIA's EGL does), after the transcript is out.
        match (serde_json::from_slice::<Transcript>(&stdout), failure) {
            (Ok(transcript), _) => return Ok(transcript),
            (Err(e), None) => {
                return Err(format!("the {label} speech program answered badly: {e}"));
            }
            (Err(_), Some(e)) => failures.push(format!("{label}: {e}")),
        }
    }
    Err(failures.join("; "))
}

/// Runs a program with a deadline. Its output goes to files, so a full pipe cannot stall it. The
/// files live in Lens's own data folder, not the shared temporary folder, and must be new.
/// A failure keeps what the program wrote, which can still be a complete answer.
fn run(
    mut command: Command,
    limit: Duration,
    private: &Path,
) -> Result<Vec<u8>, (String, Vec<u8>)> {
    static RUNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let run = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let scratch = private.join(format!("speech-{}-{run}", std::process::id()));
    let plain = |e: String| (e, Vec::new());
    std::fs::create_dir_all(&scratch).map_err(|e| plain(e.to_string()))?;
    let result = (|| -> Result<Vec<u8>, String> {
        let new = |name: &str| {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(scratch.join(name))
                .map_err(|e| e.to_string())
        };
        let (stdout, stderr) = (new("out")?, new("err")?);
        let mut child = command
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
            .map_err(|e| format!("cannot start it: {e}"))?;
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if started.elapsed() > limit {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "it ran longer than {} minutes",
                    limit.as_secs() / 60
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        if status.success() {
            Ok(Vec::new())
        } else {
            let errors = std::fs::read_to_string(scratch.join("err")).unwrap_or_default();
            let last = errors
                .lines()
                .rev()
                .find(|l| l.starts_with("lens-speech:"))
                .unwrap_or("");
            Err(format!("it stopped ({status}) {last}").trim_end().into())
        }
    })();
    let stdout = std::fs::read(scratch.join("out")).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&scratch);
    match result {
        Ok(_) => Ok(stdout),
        Err(e) => Err((e, stdout)),
    }
}

/// The length of a 16 kHz mono 16-bit WAV, or why it is not one.
pub fn wav_duration_ms(header: &[u8], size: u64) -> Result<i64, String> {
    let (_, length) = wav_data(header, size)?;
    Ok((length / 32) as i64)
}

/// How many bytes of a WAV `wav_data` reads: room for chunks such as LIST before the samples.
pub const WAV_HEADER_BYTES: u32 = 4096;

/// Where the samples of a 16 kHz mono 16-bit WAV are: (offset, length) in a file of `size` bytes.
/// Chunks other than fmt and data (LIST, fact) may come first, so the chunks are walked.
pub fn wav_data(header: &[u8], size: u64) -> Result<(u64, u64), String> {
    let invalid = || "the voice note must be a 16 kHz mono 16-bit WAV".to_string();
    let u16_at = |i: usize| {
        header
            .get(i..i + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
    };
    let u32_at = |i: usize| {
        header
            .get(i..i + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    if header.get(0..4) != Some(b"RIFF") || header.get(8..12) != Some(b"WAVE") {
        return Err(invalid());
    }
    let mut at = 12;
    let mut format = false;
    while let (Some(id), Some(length)) = (header.get(at..at + 4), u32_at(at + 4)) {
        let body = at + 8;
        match id {
            b"fmt " => {
                format = u16_at(body) == Some(1)
                    && u16_at(body + 2) == Some(1)
                    && u32_at(body + 4) == Some(16_000)
                    && u16_at(body + 14) == Some(16);
                if !format {
                    return Err(invalid());
                }
            }
            b"data" if format => {
                let rest = size.saturating_sub(body as u64);
                // A recorder that streams may write 0 (or 0xFFFFFFFF) and never fix it: the file
                // size then gives the length.
                let declared = u64::from(length);
                let length = if declared == 0 {
                    rest
                } else {
                    declared.min(rest)
                };
                return Ok((body as u64, length));
            }
            _ => {}
        }
        // Chunks are padded to an even length.
        at = body + length as usize + (length as usize & 1);
    }
    Err(invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> Vec<u8> {
        let mut h = Vec::new();
        h.extend_from_slice(b"RIFF\0\0\0\0WAVEfmt ");
        h.extend_from_slice(&16u32.to_le_bytes());
        h.extend_from_slice(&1u16.to_le_bytes());
        h.extend_from_slice(&1u16.to_le_bytes());
        h.extend_from_slice(&16_000u32.to_le_bytes());
        h.extend_from_slice(&32_000u32.to_le_bytes());
        h.extend_from_slice(&2u16.to_le_bytes());
        h.extend_from_slice(&16u16.to_le_bytes());
        h.extend_from_slice(b"data\0\0\0\0");
        h
    }

    #[test]
    fn a_wav_header_gives_the_length() {
        assert_eq!(wav_duration_ms(&header(), 44 + 32_000), Ok(1000));
        let mut stereo = header();
        stereo[22] = 2;
        assert!(wav_duration_ms(&stereo, 100).is_err());
        assert!(wav_duration_ms(b"not a wav", 100).is_err());
        // A LIST chunk before the samples (as ffmpeg and many editors write it).
        let mut listed = header();
        let data = listed.split_off(36);
        listed.extend_from_slice(b"LIST\x05\0\0\0INFOx\0");
        listed.extend_from_slice(&data);
        assert_eq!(wav_data(&listed, 58 + 32_000), Ok((58, 32_000)));
        assert_eq!(wav_duration_ms(&listed, 58 + 32_000), Ok(1000));
    }

    #[test]
    fn a_hung_program_is_stopped() {
        #[cfg(unix)]
        {
            let mut command = Command::new("sleep");
            command.arg("5");
            let started = Instant::now();
            let dir = tempfile::tempdir().unwrap();
            assert!(run(command, Duration::from_millis(300), dir.path()).is_err());
            assert!(started.elapsed() < Duration::from_secs(3));
        }
    }

    /// What a program wrote before it crashed stays readable: a GPU driver can crash on exit
    /// after the transcript is out.
    #[test]
    fn a_crash_keeps_the_output() {
        #[cfg(unix)]
        {
            let mut command = Command::new("sh");
            command.args(["-c", "echo done; kill -SEGV $$"]);
            let dir = tempfile::tempdir().unwrap();
            let (_, stdout) = run(command, Duration::from_secs(5), dir.path()).unwrap_err();
            assert_eq!(stdout, b"done\n");
        }
    }
}
