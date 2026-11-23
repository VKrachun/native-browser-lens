import { useCallback, useRef, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { PrivacySettings } from '@/protocol/PrivacySettings';
import { PRIVACY_KEY, setCustomRedaction } from '@/collector/sanitize';
import { Problem, useLoadOnFocus } from './shared';

type Rules = Record<keyof PrivacySettings, string>;

const FIELDS: { key: keyof PrivacySettings; label: string; hint: string; placeholder: string }[] = [
  {
    key: 'maskSelectors',
    label: 'Mask these elements',
    hint: 'CSS selectors, one per line. Lens covers them in screenshots and recordings.',
    placeholder: '.pii\n[data-private]\n#billing-card',
  },
  {
    key: 'sensitiveHeaders',
    label: 'Redact these headers and fields',
    hint: 'Header or field names, one per line. Lens removes their values.',
    placeholder: 'x-tenant-token\ncustomer_ssn',
  },
  {
    key: 'sensitivePatterns',
    label: 'Redact text that matches',
    hint: 'Regular expressions (JavaScript), one per line. Lens replaces each match.',
    placeholder: 'ACME-\\d{6}\n\\b[A-Z]{2}\\d{8}\\b',
  },
];

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
const asText = (settings: PrivacySettings): Rules => ({
  maskSelectors: settings.maskSelectors.join('\n'),
  sensitiveHeaders: settings.sensitiveHeaders.join('\n'),
  sensitivePatterns: settings.sensitivePatterns.join('\n'),
});

/** Selectors not even the browser can read, so a mask would never apply. */
function badSelectors(selectors: string[]) {
  return selectors.filter((selector) => {
    try {
      document.createDocumentFragment().querySelector(selector);
      return false;
    } catch {
      return true;
    }
  });
}

/** The person's own redaction rules, on top of the built-in ones. */
export function PrivacyRules({ client }: { client: LensClient }) {
  const [rules, setRules] = useState<Rules | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(
    () =>
      client
        .request({ method: 'getPrivacySettings' })
        // An edit in progress stays: the focus does not replace what the person types.
        .then((found) => setRules((current) => (current && dirtyRef.current ? current : asText(found))))
        .catch((error: Error) => setProblem(error.message)),
    [client],
  );
  useLoadOnFocus(load);

  if (!rules) return problem ? <Problem text={problem} /> : null;
  const settings: PrivacySettings = {
    maskSelectors: lines(rules.maskSelectors),
    sensitiveHeaders: lines(rules.sensitiveHeaders),
    sensitivePatterns: lines(rules.sensitivePatterns),
  };
  // The check the recorder makes: a rule it rejects does nothing, so the person hears it now.
  const invalid = {
    maskSelectors: badSelectors(settings.maskSelectors),
    sensitiveHeaders: [],
    sensitivePatterns: setCustomRedaction({ sensitivePatterns: settings.sensitivePatterns }),
  };
  const blocked = invalid.maskSelectors.length + invalid.sensitivePatterns.length > 0;

  async function save() {
    setProblem(null);
    try {
      const stored = await client.request({ method: 'setPrivacySettings', params: settings });
      // The background and the recorders read this key: the new rules apply now, not at the next start.
      await browser.storage.local.set({ [PRIVACY_KEY]: stored });
      dirtyRef.current = false;
      setDirty(false);
      setRules(asText(stored));
      setSaved(true);
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  return (
    <section aria-label="Privacy rules" className="card settings-section">
      <div className="section">
        <h2>Privacy rules</h2>
        <p className="small muted">
          Lens always removes passwords, tokens, cookies and card numbers. Add your own rules for the data of your product.
        </p>
      </div>
      {FIELDS.map((field) => (
        <div className="field" key={field.key}>
          <label htmlFor={`privacy-${field.key}`} className="label">
            {field.label}
          </label>
          <textarea
            id={`privacy-${field.key}`}
            className="textarea code"
            rows={3}
            spellCheck={false}
            placeholder={field.placeholder}
            value={rules[field.key]}
            onChange={(e) => {
              dirtyRef.current = true;
              setDirty(true);
              setSaved(false);
              setRules({ ...rules, [field.key]: e.target.value });
            }}
          />
          <span className="small muted">{field.hint}</span>
          {invalid[field.key].length > 0 && (
            <span className="small danger-text" role="alert">
              Not valid: {invalid[field.key].join(', ')}
            </span>
          )}
        </div>
      ))}
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!dirty || blocked}>
          Save rules
        </button>
        {saved && (
          <span className="small muted" role="status">
            Rules saved.
          </span>
        )}
      </div>
      {problem && <Problem text={problem} />}
    </section>
  );
}
