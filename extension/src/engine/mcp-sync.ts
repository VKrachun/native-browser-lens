import type { Review } from '@/protocol/Review';
import { getFilingAttempt, getReview, getSetting, setSetting } from './db';
import { buildReviewBundle } from './export';
import { bytesToBase64 } from './helpers';

export interface RemoteMcpConfig {
  enabled: boolean;
  endpoint: string;
  token: string;
  autoSync: boolean;
}

export const DEFAULT_MCP_ENDPOINT = 'https://lens.sirv.studio';

export async function getRemoteMcpConfig(): Promise<RemoteMcpConfig> {
  const saved = await getSetting<Partial<RemoteMcpConfig> | null>('mcp.remote', null);
  return {
    enabled: saved?.enabled ?? false,
    endpoint: saved?.endpoint ?? DEFAULT_MCP_ENDPOINT,
    token: saved?.token ?? '',
    autoSync: saved?.autoSync ?? true,
  };
}

export async function saveRemoteMcpConfig(patch: Partial<RemoteMcpConfig>): Promise<RemoteMcpConfig> {
  const cur = await getRemoteMcpConfig();
  const next: RemoteMcpConfig = {
    enabled: patch.enabled ?? cur.enabled,
    endpoint: (patch.endpoint ?? cur.endpoint).trim().replace(/\/+$/, '') || DEFAULT_MCP_ENDPOINT,
    token: (patch.token ?? cur.token).trim(),
    autoSync: patch.autoSync ?? cur.autoSync,
  };
  await setSetting('mcp.remote', next);
  return next;
}

export function generateRemoteMcpToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `lens_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface SyncedReviewPayload {
  review: Review;
  vibeqTaskId: string | null;
  vibeqTaskUrl: string | null;
  files: Record<string, { contentType: string; encoding: 'utf8' | 'base64'; body: string }>;
}

/** Uploads a frozen review and its derived files to the remote HTTP MCP Cloudflare Worker. */
export async function syncReviewToRemoteMcp(reviewId: number): Promise<{ ok: boolean; mcpUrl: string; reviewId: number }> {
  const cfg = await getRemoteMcpConfig();
  if (!cfg.token) throw new Error('Generate or paste a Remote MCP token in Settings → Coding agents first.');

  const review = await getReview(reviewId);
  const filing = await getFilingAttempt(reviewId);
  const bundle = await buildReviewBundle(review);

  const files: SyncedReviewPayload['files'] = {};
  const decoder = new TextDecoder();
  for (const [name, entry] of bundle.files) {
    // Keep remote MCP payload lean (skip raw >8 MiB binary WebM; keep screenshots, shots, json, specs, har, timeline, report)
    if (entry.bytes.byteLength > 8 * 1024 * 1024) continue;
    const isText =
      entry.contentType.startsWith('text/') ||
      entry.contentType.includes('json') ||
      name.endsWith('.ts') ||
      name.endsWith('.md');
    files[name] = isText
      ? { contentType: entry.contentType, encoding: 'utf8', body: decoder.decode(entry.bytes) }
      : { contentType: entry.contentType, encoding: 'base64', body: bytesToBase64(entry.bytes) };
  }

  const payload: SyncedReviewPayload = {
    review,
    vibeqTaskId: filing?.receipt?.taskId ?? null,
    vibeqTaskUrl: filing?.receipt?.taskUrl ?? null,
    files,
  };

  const res = await fetch(`${cfg.endpoint}/api/mcp/reviews/${review.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Remote MCP sync failed (HTTP ${res.status}): ${err.slice(0, 200)}`);
  }
  return { ok: true, mcpUrl: `${cfg.endpoint}/mcp`, reviewId: review.id };
}
