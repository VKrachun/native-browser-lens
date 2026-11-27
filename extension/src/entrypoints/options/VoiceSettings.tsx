import { useCallback, useEffect, useState } from 'react';
import {
  defaultLocalSpeechModel,
  getSpeechConfig,
  LOCAL_WHISPER_MODELS,
  saveSpeechConfig,
  type SpeechBackend,
  type SpeechConfig,
} from '@/engine/speech';
import type { LensClient } from '@/lens-client';
import type { SpeechStatus } from '@/protocol/SpeechStatus';
import { DoneIcon } from '@/ui/icons';
import { ModelNotice } from '../sidepanel/Voice';
import { Problem, useLoadOnFocus } from './shared';

const BACKENDS: Array<[SpeechBackend, string, string]> = [
  ['local', 'In-browser local model (Parakeet TDT / Whisper on WebGPU & WASM)', 'Runs 100% locally in your browser with zero API cost. Downloads once and caches locally.'],
  ['groq', 'Groq Cloud STT (whisper-large-v3-turbo)', 'Ultra-fast cloud Whisper transcription using your Groq API key.'],
  ['openai', 'OpenAI Cloud STT (whisper-1)', 'Cloud Whisper transcription using your OpenAI API key.'],
];

const LANGUAGES = [
  ['en', 'English (en)'],
  ['uk', 'Ukrainian (uk)'],
  ['de', 'German (de)'],
  ['fr', 'French (fr)'],
  ['es', 'Spanish (es)'],
  ['pt', 'Portuguese (pt)'],
  ['ja', 'Japanese (ja)'],
  ['zh', 'Chinese (zh)'],
] as const;
const OTHER = 'other';
const MAX_PROMPT = 1000;

/** Speech-to-text settings: in-browser Whisper (WebGPU/WASM) or optional OpenAI/Groq cloud STT. */
export function Voice({ client }: { client: LensClient }) {
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const [config, setConfig] = useState<SpeechConfig | null>(null);
  const [otherLanguage, setOtherLanguage] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const loadStatus = useCallback(() => client.request({ method: 'speechStatus' }).then(setSpeech).catch(() => {}), [client]);
  const load = useCallback(
    () =>
      Promise.all([
        loadStatus(),
        getSpeechConfig().then((found) => {
          setConfig(found);
          setPrompt(found.prompt ?? '');
          setOtherLanguage(found.language !== null && !LANGUAGES.some(([code]) => code === found.language));
        }),
      ]).catch((error: Error) => setProblem(error.message)),
    [loadStatus],
  );
  useLoadOnFocus(load);

  useEffect(() => {
    if (speech?.model.state !== 'downloading') return;
    const timer = setInterval(() => void loadStatus(), 1000);
    return () => clearInterval(timer);
  }, [speech?.model.state, loadStatus]);

  async function save(patch: Partial<SpeechConfig>) {
    setProblem(null);
    setConfig((cur) => (cur ? { ...cur, ...patch } : cur));
    try {
      const saved = await saveSpeechConfig(patch);
      setConfig(saved);
      setPrompt(saved.prompt ?? '');
      await loadStatus();
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  if (!speech || !config) return problem ? <Problem text={problem} /> : null;
  const engines = speech.engines.length ? speech.engines.join(', then ') : 'none found';
  const language = otherLanguage ? OTHER : (config.language ?? '');

  return (
    <section aria-label="Voice notes" className="card settings-section">
      <div className="section">
        <h2>Voice notes</h2>
        <p className="small muted">
          Transcribe voice recordings locally in your browser with Parakeet TDT or Whisper (WebGPU / WASM), or use your
          own Groq or OpenAI API key for instant cloud transcription.
        </p>
      </div>

      <div className="choices" role="radiogroup" aria-label="Transcription backend">
        {BACKENDS.map(([value, label, detail]) => (
          <label key={value} className="check">
            <input
              type="radio"
              name="speech-backend"
              checked={config.backend === value}
              onChange={() =>
                void save({
                  backend: value,
                  model: value === 'local' ? defaultLocalSpeechModel() : value === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1',
                })
              }
            />
            <span>
              {label}
              <span className="small muted" style={{ display: 'block' }}>
                {detail}
              </span>
            </span>
          </label>
        ))}
      </div>

      {config.backend === 'local' && (
        <>
          {speech.model.state === 'ready' ? (
            <p className="small" role="status" aria-label="Speech model">
              <DoneIcon size={14} /> {speech.modelName} is ready. Engine: {engines}.
            </p>
          ) : (
            <ModelNotice
              speech={speech}
              onInstall={() => client.request({ method: 'installSpeech' }).then(setSpeech)}
              onCancel={() => client.request({ method: 'cancelSpeechDownload' }).then(setSpeech)}
            />
          )}
          <div className="choices" role="radiogroup" aria-label="Speech model size">
            {Object.entries(LOCAL_WHISPER_MODELS).map(([value, info]) => (
              <label key={value} className="check">
                <input
                  type="radio"
                  name="speech-model"
                  checked={config.model === value}
                  onChange={() => void save({ model: value })}
                />
                <span>{info.label}</span>
              </label>
            ))}
          </div>
          {import.meta.env.FIREFOX === true && (
            <p className="small muted">
              On Firefox, Whisper base (~75 MB) runs fastest and stays well under Firefox&apos;s extension memory limit;
              Parakeet TDT uses ~2 GB RAM on WASM.
            </p>
          )}
        </>
      )}

      {config.backend === 'groq' && (
        <div className="field">
          <label htmlFor="groq-stt-key" className="label">
            Groq API key
          </label>
          <input
            id="groq-stt-key"
            className="input"
            type="password"
            autoComplete="off"
            defaultValue={config.groqApiKey}
            placeholder="gsk_..."
            onBlur={(e) => {
              if (e.target.value.trim() !== config.groqApiKey) void save({ groqApiKey: e.target.value.trim() });
            }}
          />
          <span className="small muted">Stored locally in your browser. Sent only to api.groq.com when transcribing.</span>
        </div>
      )}

      {config.backend === 'openai' && (
        <div className="field">
          <label htmlFor="openai-stt-key" className="label">
            OpenAI API key
          </label>
          <input
            id="openai-stt-key"
            className="input"
            type="password"
            autoComplete="off"
            defaultValue={config.openaiApiKey}
            placeholder="sk-..."
            onBlur={(e) => {
              if (e.target.value.trim() !== config.openaiApiKey) void save({ openaiApiKey: e.target.value.trim() });
            }}
          />
          <span className="small muted">Stored locally in your browser. Sent only to api.openai.com when transcribing.</span>
        </div>
      )}

      <div className="field">
        <label htmlFor="speech-language" className="label">
          Language
        </label>
        <div className="inline-fields">
          <select
            id="speech-language"
            className="select"
            value={language}
            onChange={(e) => {
              const value = e.target.value;
              setOtherLanguage(value === OTHER);
              if (value !== OTHER) void save({ language: value || null });
            }}
          >
            <option value="">Auto-detect</option>
            {LANGUAGES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
          {otherLanguage && (
            <input
              aria-label="Language code"
              className="input language-code"
              defaultValue={config.language ?? ''}
              placeholder="nl"
              maxLength={8}
              onBlur={(e) => {
                const code = e.target.value.trim().toLowerCase();
                if (code !== (config.language ?? '')) void save({ language: code || null });
              }}
            />
          )}
        </div>
      </div>

      <div className="field">
        <label htmlFor="speech-prompt" className="label">
          Words to expect
        </label>
        <textarea
          id="speech-prompt"
          className="textarea"
          rows={2}
          maxLength={MAX_PROMPT}
          placeholder="e.g. Sirv Lens, VibeQ, GraphQL, Kubernetes"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => {
            if (prompt.trim() !== (config.prompt ?? '')) void save({ prompt: prompt.trim() || null });
          }}
        />
        <span className="small muted">Product names, API names and people. Saved when you leave the box.</span>
      </div>

      {problem && <Problem text={problem} />}
    </section>
  );
}
