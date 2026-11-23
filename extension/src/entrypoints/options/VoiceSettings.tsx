import { useCallback, useEffect, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { SpeechStatus } from '@/protocol/SpeechStatus';
import type { SpeechSettings } from '@/protocol/SpeechSettings';
import { DoneIcon } from '@/ui/icons';
import { ModelNotice } from '../sidepanel/Voice';
import { Problem, useLoadOnFocus } from './shared';

const MODELS = [
  ['large-v3-turbo', 'Whisper large-v3-turbo (574 MB — highest accuracy)'],
  ['small', 'Whisper small (190 MB — faster on CPU)'],
] as const;

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

/** The speech model for voice notes: which one, the language, the words to expect, and its download. */
export function Voice({ client }: { client: LensClient }) {
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const [settings, setSettings] = useState<SpeechSettings | null>(null);
  /** The language select shows Other…: the code is typed. */
  const [otherLanguage, setOtherLanguage] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const loadStatus = useCallback(() => client.request({ method: 'speechStatus' }).then(setSpeech).catch(() => {}), [client]);
  const load = useCallback(
    () =>
      Promise.all([
        loadStatus(),
        client.request({ method: 'getSpeechSettings' }).then((found) => {
          setSettings(found);
          setPrompt(found.prompt ?? '');
          setOtherLanguage(found.language !== null && !LANGUAGES.some(([code]) => code === found.language));
        }),
      ]).catch((error: Error) => setProblem(error.message)),
    [client, loadStatus],
  );
  useLoadOnFocus(load);
  useEffect(() => {
    if (speech?.model.state !== 'downloading') return;
    const timer = setInterval(() => void loadStatus(), 1000);
    return () => clearInterval(timer);
  }, [speech?.model.state, loadStatus]);

  async function save(change: Partial<SpeechSettings>) {
    if (!settings) return;
    setProblem(null);
    try {
      const saved = await client.request({ method: 'setSpeechSettings', params: { ...settings, ...change } });
      setSettings(saved);
      setPrompt(saved.prompt ?? '');
      // Another model is another download, maybe already here.
      if (change.model) await loadStatus();
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  if (!speech) return problem ? <Problem text={problem} /> : null;
  const engines = speech.engines.length ? speech.engines.join(', then ') : 'none found';
  const language = otherLanguage ? OTHER : (settings?.language ?? '');
  return (
    <section aria-label="Voice notes" className="card settings-section">
      <div className="section">
        <h2>Voice notes</h2>
        <p className="small muted">
          Lens writes down what you say with {speech.modelName}, on this computer. The recordings never leave it;
          transcripts leave only in a review you create.
        </p>
      </div>
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
      {settings && (
        <>
          <div className="choices" role="radiogroup" aria-label="Speech model size">
            {MODELS.map(([value, label]) => (
              <label key={value} className="check">
                <input
                  type="radio"
                  name="speech-model"
                  checked={settings.model === value}
                  onChange={() => void save({ model: value })}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
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
                  defaultValue={settings.language ?? ''}
                  placeholder="nl"
                  maxLength={8}
                  onBlur={(e) => {
                    const code = e.target.value.trim().toLowerCase();
                    if (code !== (settings.language ?? '')) void save({ language: code || null });
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
                if (prompt.trim() !== (settings.prompt ?? '')) void save({ prompt: prompt.trim() || null });
              }}
            />
            <span className="small muted">Product names, API names and people. Lens saves them when you leave the box.</span>
          </div>
        </>
      )}
      {problem && <Problem text={problem} />}
    </section>
  );
}
