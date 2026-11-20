import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { LensClient } from '@/lens-client';
import type { DestinationSettings } from '@/protocol/DestinationSettings';
import type { Tracker } from '@/protocol/Tracker';
import { trackerNames } from '@/tracker-drafts';

const addressFields: Partial<Record<Tracker, [string, string]>> = {
  jira: ['Jira Cloud site', 'https://team.atlassian.net'],
  basecamp: ['Basecamp to-do list or form URL', 'https://app.basecamp.com/…'],
  github: ['GitHub repository', 'https://github.com/owner/repo'],
};

async function migrateBrowserChoice(client: LensClient, settings: DestinationSettings) {
  const key = 'lens.draftDestination';
  const legacy = (await browser.storage.local.get(key))[key];
  if (typeof legacy !== 'string' || !Object.hasOwn(trackerNames, legacy)) return settings;
  const tracker = legacy as Tracker;
  const addressKey = 'lens.draftAddress.' + tracker;
  const address = String((await browser.storage.local.get(addressKey))[addressKey] ?? '');
  if ((addressFields[tracker] && !address) || (tracker === 'vibeq' && !settings.vibeqConnected)) return settings;
  const migrated = await client.request({
    method: 'setDestination', params: { choice: { tracker, address }, onlyIfUnset: true },
  }).catch(() => settings);
  if (migrated.choice) await browser.storage.local.remove(key);
  return migrated;
}

const OUTDATED = 'Update the Lens app to choose a default destination.';

export function useDestination(client: LensClient) {
  const [settings, setSettings] = useState<DestinationSettings | null>(null);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const checkedBrowserChoice = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      let hint = '';
      let next = await client.request({ method: 'getDestination' }).catch(async (e: Error) => {
        if (!e.message.includes('unknown variant `getDestination`')) throw e;
        hint = OUTDATED;
        const account = await client.request({ method: 'getVibeQ' });
        const connected = Boolean(account.endpoint && account.hasToken);
        return { choice: connected ? { tracker: 'vibeq' as const, address: '' } : null, vibeqConnected: connected };
      });
      if (!hint && !checkedBrowserChoice.current) {
        next = await migrateBrowserChoice(client, next);
        checkedBrowserChoice.current = true;
      }
      if (request === sequence.current) {
        setSettings((previous) => previous &&
          previous.vibeqConnected === next.vibeqConnected &&
          previous.choice?.tracker === next.choice?.tracker &&
          previous.choice?.address === next.choice?.address ? previous : next);
        setError(hint);
      }
    } catch (e) {
      if (request === sequence.current) setError((e as Error).message);
    }
  }, [client]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) await refresh();
      if (active) timer = setTimeout(poll, 3000);
    };
    void poll();
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('lens-destination-changed', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      clearTimeout(timer);
      ++sequence.current;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('lens-destination-changed', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  return { settings, error, refresh };
}

export function DestinationForm({ client, onboarding = false }: { client: LensClient; onboarding?: boolean }) {
  const { settings, error, refresh } = useDestination(client);
  const [tracker, setTracker] = useState<Tracker | '' | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  if (onboarding && (!settings || settings.choice)) return null;
  const selected = tracker ?? settings?.choice?.tracker ?? '';
  const field = selected ? addressFields[selected] : undefined;
  const value = address ?? (selected === settings?.choice?.tracker ? settings?.choice?.address : '') ?? '';

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setProblem('');
    try {
      await client.request({ method: 'setDestination', params: {
        choice: { tracker: selected, address: field ? value.trim() : '' }, onlyIfUnset: false,
      }});
      await refresh();
      setTracker(null);
      setAddress(null);
      setMessage('Default saved.');
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card settings-section destination-settings" aria-label="Default destination">
      <h2>{onboarding ? 'Where do you track issues?' : 'Default destination'}</h2>
      <p className="small muted">Lens uses this destination for every review on this computer.</p>
      {/* A failed poll (the app restarts) keeps the form; only an app too old for it hides it. */}
      {settings && error !== OUTDATED && <form onSubmit={save}>
        <label>Destination
          <select aria-label="Destination" className="select" value={selected} required onChange={(e) => {
            setTracker(e.target.value as Tracker);
            setAddress(null);
            setMessage('');
            setProblem('');
          }}>
            <option value="" disabled>Choose a destination</option>
            {Object.entries(trackerNames).filter(([key]) => key !== 'vibeq' || settings.vibeqConnected).map(([key, name]) =>
              <option key={key} value={key}>{name}</option>
            )}
          </select>
        </label>
        {field && <label>{field[0]}
          <input className="input" type="url" required placeholder={field[1]} value={value}
            onChange={(e) => { setAddress(e.target.value); setMessage(''); setProblem(''); }} />
        </label>}
        <button type="submit" className="btn btn-secondary" disabled={busy || !selected || (!!field && !value.trim())}>Save default</button>
      </form>}
      {(problem || error) && <p role="alert" className="small">{problem || error}</p>}
      {message && <p role="status" className="small">{message}</p>}
    </section>
  );
}
