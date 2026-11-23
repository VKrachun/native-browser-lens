import { useEffect, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { Capture } from '@/protocol/Capture';
import type { PrivacySettings } from '@/protocol/PrivacySettings';
import { readText } from './Evidence';
import { privacyCounts, type PrivacyCounts } from './reviewHelpers';

/** The privacy counts of these captures; null until the evidence is read. */
export function usePrivacySummary(client: LensClient, captures: Capture[], shots: boolean): PrivacyCounts | null {
  const [settings, setSettings] = useState<PrivacySettings | null>(null);
  const [evidence, setEvidence] = useState<string[] | null>(null);
  useEffect(() => {
    client.request({ method: 'getPrivacySettings' }).then(setSettings, () => setSettings(null));
  }, [client]);
  useEffect(() => {
    let alive = true;
    // A blob that does not read counts no redactions: the summary says what it saw.
    void Promise.all(captures.map((c) => readText(client, c.evidence).catch(() => ''))).then((texts) => alive && setEvidence(texts));
    return () => {
      alive = false;
    };
  }, [client, captures]);
  return evidence ? privacyCounts(captures, evidence, settings, shots) : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the review hides before it leaves: redacted values, masks, the person's own rules, and a
 * reminder for screenshots that nobody masked. The person confirms those before a one-click filing.
 */
export function PrivacySummary({
  counts,
  checked,
  onChecked,
}: {
  counts: PrivacyCounts | null;
  checked: boolean;
  onChecked: (checked: boolean) => void;
}) {
  if (!counts) return null;
  return (
    <section className="card privacy-summary" aria-label="Privacy summary">
      <div className="privacy-pills">
        <span className="pill" data-tone={counts.redacted ? 'success' : undefined}>
          {plural(counts.redacted, 'value redacted', 'values redacted')}
        </span>
        <span className="pill" data-tone={counts.masks ? 'success' : undefined}>
          {plural(counts.masks, 'mask or blur', 'masks and blurs')}
        </span>
        <span className="pill">{plural(counts.rules, 'custom rule', 'custom rules')}</span>
      </div>
      {counts.unmasked > 0 && (
        <label className="check small">
          <input type="checkbox" checked={checked} onChange={(e) => onChecked(e.target.checked)} />
          <span>
            {plural(counts.unmasked, 'screenshot has', 'screenshots have')} no mask. I checked that they show nothing private.
          </span>
        </label>
      )}
    </section>
  );
}
