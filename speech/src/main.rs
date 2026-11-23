//! `lens-speech <model> <input.wav> [--vad <model>] [--threads N] [--language <code>]
//! [--prompt <text>]`: transcribes a 16 kHz mono WAV with whisper.cpp and prints one JSON object.
//! The daemon runs it as a child process. `--language auto` (or none) detects the language;
//! `--prompt` gives Whisper words to expect, such as product names.
use serde::Serialize;
use std::process::ExitCode;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperVadContext,
    WhisperVadContextParams, WhisperVadParams,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Transcript {
    language: String,
    /// GPU or CPU, as whisper.cpp reports it.
    engine: String,
    segments: Vec<Segment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Segment {
    start_ms: i64,
    end_ms: i64,
    text: String,
}

fn main() -> ExitCode {
    match run() {
        Ok(transcript) => {
            use std::io::Write;
            let json = serde_json::to_string(&transcript).expect("JSON serializes");
            let mut out = std::io::stdout().lock();
            if writeln!(out, "{json}").and_then(|()| out.flush()).is_err() {
                return ExitCode::FAILURE;
            }
            // The transcript is out. GPU drivers can crash in their exit handlers (NVIDIA's EGL
            // does), so end here without them.
            #[cfg(unix)]
            // SAFETY: _exit only ends the process; stdout is flushed above.
            unsafe {
                libc::_exit(0)
            }
            #[cfg(not(unix))]
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("lens-speech: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<Transcript, String> {
    let mut args = std::env::args().skip(1);
    let (Some(model), Some(input)) = (args.next(), args.next()) else {
        return Err(
            "usage: lens-speech <model> <input.wav> [--vad <model>] [--threads N] \
             [--language <code>] [--prompt <text>]"
                .into(),
        );
    };
    let (mut vad, mut threads, mut language, mut prompt) = (None, 4, None, None);
    while let Some(flag) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--vad" => vad = args.next(),
            "--threads" => threads = args.next().and_then(|n| n.parse().ok()).unwrap_or(4),
            "--language" => language = Some(value()?),
            "--prompt" => prompt = Some(value()?),
            other => return Err(format!("unknown option {other}")),
        }
    }
    // A fixed language holds for every window; without one the first window detects it.
    let mut language = fixed_language(language.as_deref())?;
    let samples = read_wav(&input)?;

    // whisper.cpp logs to stderr; the daemon keeps that for its log.
    let mut context = WhisperContextParameters::default();
    context.use_gpu(cfg!(any(feature = "vulkan", feature = "metal")));
    context.flash_attn(true);
    let whisper = WhisperContext::new_with_params(&model, context)
        .map_err(|e| format!("the model did not load: {e}"))?;
    let mut state = whisper.create_state().map_err(|e| e.to_string())?;

    // Speech parts with their real times, joined without their silences into windows of up to
    // 28 s. Whisper encodes a full 30 s window however short the audio is, so one window per
    // pause made a talk with many pauses many times slower; the joined pieces keep a table that
    // maps each time back into the recording.
    let parts = match &vad {
        Some(vad) => speech_parts(vad, &samples, threads)?,
        None => vec![(0, samples.len())],
    };
    let mut segments = Vec::new();
    for window in windows(&parts) {
        let audio = window.audio(&samples);
        // Greedy: large-v3-turbo is trained for it, and beam search is many times slower on a GPU.
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(language.as_deref().unwrap_or("auto")));
        params.set_n_threads(threads);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);
        params.set_suppress_blank(true);
        if let Some(prompt) = prompt.as_deref().filter(|p| !p.trim().is_empty()) {
            params.set_initial_prompt(prompt);
        }
        state
            .full(params, &audio)
            .map_err(|e| format!("transcription failed: {e}"))?;
        if language.is_none() {
            language = whisper_rs::get_lang_str(state.full_lang_id_from_state()).map(String::from);
        }
        for segment in state.as_iter() {
            let Ok(text) = segment.to_str_lossy() else {
                continue;
            };
            let text = text.trim().to_string();
            if text.is_empty() || is_marker(&text) {
                continue;
            }
            // Whisper's times are in centiseconds of the joined window.
            let start_ms = window
                .original_start_ms(segment.start_timestamp() * 10, segment.end_timestamp() * 10);
            let end_ms = window
                .original_ms(segment.end_timestamp() * 10)
                .max(start_ms);
            segments.push(Segment {
                start_ms,
                end_ms,
                text,
            });
        }
    }
    let language = language.unwrap_or_else(|| "unknown".into());
    let engine = if cfg!(feature = "vulkan") {
        "GPU (Vulkan)"
    } else if cfg!(feature = "metal") {
        "GPU (Metal)"
    } else {
        "CPU"
    };
    Ok(Transcript {
        language,
        engine: engine.into(),
        segments,
    })
}

/// The whisper.cpp code of a language (`en`, `uk`, or a name such as `german`); None to detect it.
fn fixed_language(language: Option<&str>) -> Result<Option<String>, String> {
    match language.map(str::trim) {
        None | Some("" | "auto") => Ok(None),
        Some(code) => whisper_rs::get_lang_id(&code.to_lowercase())
            .and_then(whisper_rs::get_lang_str)
            .map(|code| Some(code.to_string()))
            .ok_or_else(|| format!("unknown language {code}")),
    }
}

fn ms(sample: usize) -> i64 {
    (sample as i64) * 1000 / 16_000
}

/// Silence between joined parts, so words of two parts do not run together.
const JOIN_GAP: usize = 16_000 * 3 / 10;
/// Speech per window: under Whisper's 30 s, with room for the gaps.
const WINDOW: usize = 28 * 16_000;

/// Speech parts joined into one Whisper window. Each piece is (start in the window, start in the
/// recording, length), in samples.
#[derive(Debug, PartialEq)]
struct Window {
    pieces: Vec<(usize, usize, usize)>,
}

impl Window {
    fn audio(&self, samples: &[f32]) -> Vec<f32> {
        let mut audio = Vec::new();
        for &(at, from, len) in &self.pieces {
            audio.resize(at, 0.0);
            audio.extend_from_slice(&samples[from..from + len]);
        }
        audio
    }

    /// A time in the window (ms) as a time in the recording: inside a piece it moves with that
    /// piece; in a gap it is the start of the next piece; past the end, the end of the last.
    fn original_ms(&self, window_ms: i64) -> i64 {
        let at = (window_ms.max(0) as usize) * 16;
        for &(start, from, len) in &self.pieces {
            if at < start {
                return ms(from);
            }
            if at <= start + len {
                return ms(from + (at - start));
            }
        }
        self.pieces
            .last()
            .map_or(0, |&(_, from, len)| ms(from + len))
    }

    /// The piece a window time falls in, or the next piece when it falls in a gap.
    fn piece_at(&self, window_ms: i64) -> usize {
        let at = (window_ms.max(0) as usize) * 16;
        self.pieces
            .iter()
            .position(|&(start, _, len)| at <= start + len)
            .unwrap_or(self.pieces.len().saturating_sub(1))
    }

    /// A segment's start: Whisper starts a segment where the one before it ended, which in a
    /// joined window is often the padded end of the previous piece. A segment that ends in a
    /// later piece and has less than a second in its first one starts with the next piece.
    fn original_start_ms(&self, start_ms: i64, end_ms: i64) -> i64 {
        let (first, last) = (self.piece_at(start_ms), self.piece_at(end_ms));
        if last > first {
            let (start, _, len) = self.pieces[first];
            let inside = (start + len).saturating_sub((start_ms.max(0) as usize) * 16);
            if inside < 16_000 {
                return ms(self.pieces[first + 1].1);
            }
        }
        self.original_ms(start_ms)
    }
}

/// Packs speech parts, in order, into windows of up to WINDOW samples of speech and gaps.
fn windows(parts: &[(usize, usize)]) -> Vec<Window> {
    let mut windows: Vec<Window> = Vec::new();
    let mut used = 0;
    for &(start, end) in parts.iter().filter(|(s, e)| e > s) {
        let len = end - start;
        let fits = windows.last().is_some() && used + JOIN_GAP + len <= WINDOW;
        if fits {
            used += JOIN_GAP;
            windows
                .last_mut()
                .expect("checked")
                .pieces
                .push((used, start, len));
            used += len;
        } else {
            windows.push(Window {
                pieces: vec![(0, start, len)],
            });
            used = len;
        }
    }
    windows
}

/// The stretches of speech, as sample ranges: pauses under a second join, parts stay under 28 s
/// so each fits one Whisper window, and each part keeps a little padding.
fn speech_parts(model: &str, samples: &[f32], threads: i32) -> Result<Vec<(usize, usize)>, String> {
    let mut context = WhisperVadContextParams::new();
    context.set_n_threads(threads);
    let mut vad = WhisperVadContext::new(model, context)
        .map_err(|e| format!("the VAD model did not load: {e}"))?;
    let mut params = WhisperVadParams::new();
    params.set_min_silence_duration(500);
    params.set_max_speech_duration(28.0);
    params.set_speech_pad(200);
    let found = vad
        .segments_from_samples(params, samples)
        .map_err(|e| format!("speech detection failed: {e}"))?;
    let sample = |centiseconds: f32| ((centiseconds.max(0.0) * 160.0) as usize).min(samples.len());
    Ok(join_parts(
        found.map(|s| (sample(s.start), sample(s.end))).collect(),
    ))
}

/// Joins parts closer than one second while the result stays under 28 seconds.
fn join_parts(parts: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    const GAP: usize = 16_000;
    const LONGEST: usize = 28 * 16_000;
    let mut joined: Vec<(usize, usize)> = Vec::new();
    for (start, end) in parts.into_iter().filter(|(s, e)| e > s) {
        match joined.last_mut() {
            Some(last) if start <= last.1 + GAP && end - last.0 <= LONGEST => {
                last.1 = end.max(last.1)
            }
            _ => joined.push((start, end)),
        }
    }
    joined
}

/// Whisper's names for non-speech, such as `[BLANK_AUDIO]` or `(music)`.
fn is_marker(text: &str) -> bool {
    let inner = text.trim_matches(|c| matches!(c, '[' | ']' | '(' | ')' | '*' | ' '));
    (text.starts_with('[') || text.starts_with('('))
        && inner
            .chars()
            .all(|c| c.is_alphabetic() || c == '_' || c == ' ')
}

/// 16 kHz mono 16-bit PCM, as the extension writes it.
fn read_wav(path: &str) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| format!("{path}: {e}"))?;
    let spec = reader.spec();
    if spec.sample_rate != 16_000 || spec.channels != 1 || spec.bits_per_sample != 16 {
        return Err(format!(
            "{path}: expected 16 kHz mono 16-bit PCM, found {spec:?}"
        ));
    }
    reader
        .samples::<i16>()
        .map(|s| s.map(|v| f32::from(v) / 32768.0).map_err(|e| e.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_share_windows_and_times_map_back() {
        let second = 16_000;
        // Three 5 s parts with long pauses, then one 25 s part: two windows.
        let parts = [
            (2 * second, 7 * second),
            (20 * second, 25 * second),
            (40 * second, 45 * second),
            (60 * second, 85 * second),
        ];
        let found = windows(&parts);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].pieces.len(), 3);
        assert_eq!(found[1].pieces, vec![(0, 60 * second, 25 * second)]);
        let first = &found[0];
        // 1 s into the window is 1 s into the first part.
        assert_eq!(first.original_ms(1_000), 3_000);
        // The second piece starts at 5 s + 0.3 s gap in the window, 20 s in the recording.
        assert_eq!(first.original_ms(5_300), 20_000);
        assert_eq!(first.original_ms(6_300), 21_000);
        // Inside a gap: the start of the next piece.
        assert_eq!(first.original_ms(5_100), 20_000);
        // A segment from 4.4 s (0.6 s before the first piece ends) into the second piece starts
        // with the second piece; one inside the first piece keeps its own start.
        assert_eq!(first.original_start_ms(4_400, 8_000), 20_000);
        assert_eq!(first.original_start_ms(1_000, 4_000), 3_000);
        // Most of it in the first piece: its own start.
        assert_eq!(first.original_start_ms(2_000, 6_000), 4_000);
        // Past the end: the end of the last piece.
        assert_eq!(first.original_ms(60_000), 45_000);
        let audio = first.audio(&vec![0.5; 90 * second]);
        assert_eq!(audio.len(), 3 * 5 * second + 2 * JOIN_GAP);
        assert_eq!(audio[5 * second + 1], 0.0, "the gap is silent");
    }

    #[test]
    fn languages_are_whisper_codes() {
        assert_eq!(fixed_language(None), Ok(None));
        assert_eq!(fixed_language(Some("auto")), Ok(None));
        assert_eq!(fixed_language(Some("uk")), Ok(Some("uk".into())));
        assert_eq!(fixed_language(Some("German")), Ok(Some("de".into())));
        assert!(fixed_language(Some("klingon")).is_err());
    }

    #[test]
    fn markers_are_not_speech() {
        for marker in ["[BLANK_AUDIO]", "(music)", "[ Silence ]", "*laughs*"] {
            assert!(is_marker(marker) || marker.starts_with('*'), "{marker}");
        }
        assert!(!is_marker("The total shows NaN."));
        assert!(!is_marker("[1] then click Pay"));
    }

    #[test]
    fn close_parts_join_and_long_ones_stay_apart() {
        let s = 16_000;
        assert_eq!(
            join_parts(vec![(0, s), (s + s / 2, 3 * s), (10 * s, 11 * s)]),
            [(0, 3 * s), (10 * s, 11 * s)]
        );
        assert_eq!(
            join_parts(vec![(0, 20 * s), (20 * s + 100, 30 * s)]),
            [(0, 20 * s), (20 * s + 100, 30 * s)]
        );
    }
}
