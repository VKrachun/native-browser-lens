import { useEffect, useState } from 'react';
import { getRemoteMcpConfig, syncReviewToRemoteMcp, type RemoteMcpConfig } from '@/engine/mcp-sync';
import type { LensClient } from '@/lens-client';
import type { HandoffApp } from '@/protocol/HandoffApp';
import { AlertIcon, DoneIcon } from '@/ui/icons';
import { useStored } from '../sidepanel/Record';
import { rememberedFolder } from './reviewHelpers';

const NAMES: Record<HandoffApp, string> = {
  claudeCode: 'Claude Code',
  codex: 'Codex',
  t3Code: 'T3 Code',
  zeron: 'Zeron',
};

/**
 * Extension-only agent handoff: syncs the frozen review to Remote HTTP MCP and copies
 * a ready-to-paste prompt for Claude Code / Codex / Cursor (no local CLI required).
 */
export function useHandoff(_client: LensClient, site: string) {
  const [mcpConfig, setMcpConfig] = useState<RemoteMcpConfig | null>(null);
  const [folders, setFolders] = useStored<Record<string, string>>('lens.handoff.folders', {});
  const [lastFolder, setLastFolder] = useStored('lens.handoff.lastFolder', '');
  const [afterFiling, setAfterFiling] = useStored('lens.handoff.afterFiling', false);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ review: number; app: HandoffApp; report: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void getRemoteMcpConfig().then(setMcpConfig).catch(() => {});
  }, []);

  useEffect(() => {
    const saved = rememberedFolder(site, folders, lastFolder);
    if (saved) setFolder(saved);
  }, [folders, lastFolder, site]);

  function remember(raw = folder) {
    const path = raw.trim();
    if (!path) return;
    if (lastFolder !== path) setLastFolder(path);
    if (site && folders[site] !== path) setFolders({ ...folders, [site]: path });
  }

  async function handOff(reviewId: number) {
    setBusy(true);
    setProblem(null);
    try {
      const cfg = await getRemoteMcpConfig();
      setMcpConfig(cfg);
      if (cfg.enabled && cfg.token) {
        const synced = await syncReviewToRemoteMcp(reviewId);
        const prompt = `Read Sirv Lens review #${reviewId} via the sirv-lens MCP server (${synced.mcpUrl}) using get_review({ review: ${reviewId} }) and playwright_test({ review: ${reviewId} }). Reproduce the bug, fix it, and verify the fix.`;
        await navigator.clipboard.writeText(prompt).catch(() => {});
        setDone({ review: reviewId, app: 'claudeCode', report: `synced to ${synced.mcpUrl} and prompt copied` });
      } else {
        const prompt = `Reproduce and fix Sirv Lens review #${reviewId}. (Enable Remote HTTP MCP in Lens Settings so coding agents can read the review directly, or attach the exported Evidence ZIP.)`;
        await navigator.clipboard.writeText(prompt);
        setDone({ review: reviewId, app: 'claudeCode', report: 'prompt copied to clipboard' });
      }
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return {
    apps: [] as HandoffApp[],
    app: undefined as HandoffApp | undefined,
    mcpConfig,
    choose: (_a: HandoffApp) => {},
    folder,
    setFolder,
    remember,
    recent: [...new Set([lastFolder, ...Object.values(folders)].filter(Boolean))],
    ready: Boolean(mcpConfig?.enabled && mcpConfig.token),
    afterFiling,
    setAfterFiling,
    busy,
    done,
    problem,
    handOff,
  };
}

export type HandoffState = ReturnType<typeof useHandoff>;
export const handoffName = (app: HandoffApp) => NAMES[app];

export function Handoff({ state, review }: { state: HandoffState; review: number }) {
  const { mcpConfig, busy, problem } = state;
  const done = state.done?.review === review ? state.done : null;
  const configured = Boolean(mcpConfig?.enabled && mcpConfig.token);

  return (
    <section className="card handoff" aria-label="Hand off">
      <h2>Hand off to a coding agent</h2>
      <p className="small muted">
        {configured
          ? `Sync this review to your Remote HTTP MCP (${mcpConfig!.endpoint}/mcp) and copy the prompt for Claude Code, Codex, or Cursor.`
          : 'Enable Remote HTTP MCP in Settings so Claude Code, Codex, and Cursor can read this review directly with no desktop app.'}
      </p>
      <div className="actions">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void state.handOff(review)}>
          {busy ? 'Syncing…' : configured ? 'Sync to Remote MCP & copy prompt' : 'Copy agent prompt'}
        </button>
        {!configured && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void browser.runtime.openOptionsPage()}
          >
            Configure Remote MCP
          </button>
        )}
      </div>
      {done && (
        <p className="small" role="status" aria-label="Hand-off">
          <DoneIcon size={14} /> Review #{review}: {done.report}.
        </p>
      )}
      {problem && (
        <div role="alert" className="notice">
          <AlertIcon />
          <span>{problem}</span>
        </div>
      )}
    </section>
  );
}
