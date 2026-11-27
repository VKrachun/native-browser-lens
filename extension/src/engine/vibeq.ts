import type { Duplicate } from '@/protocol/Duplicate';
import type { Filing } from '@/protocol/Filing';
import type { Member } from '@/protocol/Member';
import type { SirvantRun } from '@/protocol/SirvantRun';
import type { TaskDestination } from '@/protocol/TaskDestination';
import type { VibeQInput } from '@/protocol/VibeQInput';
import type { VibeQSettings } from '@/protocol/VibeQSettings';
import {
  getFilingAttempt,
  getInstallId,
  getObservation,
  getReview,
  getSetting,
  listObservationFilings,
  listProjects,
  saveFilingAttempt,
  setSetting,
  type StoredFilingAttempt,
} from './db';
import { badRequest, LensError } from './errors';
import { buildReviewBundle } from './export';
import { cleanTags, sha256Hex, splitFindingsBlock, uuidv5 } from './helpers';

const inFlightObs = new Set<number>();
const MAX_MARKDOWN_LEN = 100_000;
const MAX_STAGE_SIZE = 200 * 1024 * 1024;
const MAX_STAGE_CONCURRENCY = 6;
const SAFE_TASK_ID = /^[A-Za-z0-9-]+$/;

function normalizeVibeQEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest(`Invalid VibeQ endpoint: ${raw}`);
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw badRequest('VibeQ endpoint must use HTTPS (or HTTP for localhost).');
  }
  if (url.username || url.password) {
    throw badRequest('VibeQ endpoint must not include credentials.');
  }
  return url.origin;
}

function validateToken(token: string): string {
  const t = token.trim();
  if (!t || /[\s;]/.test(t)) {
    throw badRequest('Invalid VibeQ token.');
  }
  return t;
}

async function vibeqFetch(endpoint: string, path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const url = `${endpoint}${path}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new LensError('internal', `VibeQ redirected unexpectedly (${res.status}) on ${path}`);
  }
  return res;
}

async function fetchMe(endpoint: string, token: string): Promise<{ id: string; name: string | null }> {
  const res = await vibeqFetch(endpoint, '/auth/me', token);
  if (res.status === 401 || res.status === 403) {
    throw new LensError('auth', 'VibeQ rejected your token. Sign in to VibeQ again in Settings.');
  }
  if (!res.ok) throw new LensError('internal', `VibeQ /auth/me failed (HTTP ${res.status})`);
  const body = (await res.json().catch(() => null)) as { id?: unknown; name?: unknown } | null;
  if (!body || typeof body.id !== 'string') throw new LensError('internal', 'VibeQ returned an invalid /auth/me response');
  return { id: body.id, name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null };
}

export async function getVibeQ(): Promise<VibeQSettings> {
  const [endpoint, token, account] = await Promise.all([
    getSetting<string | null>('vibeq.endpoint', null),
    getSetting<string | null>('vibeq.token', null),
    getSetting<string | null>('vibeq.account', null),
  ]);
  return {
    endpoint,
    hasToken: Boolean(token),
    account,
    tokenFromEnvironment: false,
    secretStore: { state: 'available' },
  };
}

export async function setVibeQ(input: VibeQInput): Promise<VibeQSettings> {
  const endpoint = normalizeVibeQEndpoint(input.endpoint);
  const rawToken = (input.token ?? '').trim();
  if (!rawToken) {
    await setSetting('vibeq.endpoint', endpoint);
    await setSetting('vibeq.token', null);
    await setSetting('vibeq.account', null);
    return getVibeQ();
  }
  const token = validateToken(rawToken);
  const me = await fetchMe(endpoint, token);
  await setSetting('vibeq.endpoint', endpoint);
  await setSetting('vibeq.token', token);
  await setSetting('vibeq.account', me.name ?? me.id);

  // Set default destination to VibeQ if unset
  const dest = await getSetting<TaskDestination | null>('task.destination', null);
  if (!dest) {
    await setSetting<TaskDestination>('task.destination', { tracker: 'vibeq', address: '' });
  }
  return getVibeQ();
}

async function requireVibeQ(): Promise<{ endpoint: string; token: string }> {
  const endpoint = await getSetting<string | null>('vibeq.endpoint', null);
  const token = await getSetting<string | null>('vibeq.token', null);
  if (!endpoint || !token) {
    throw new LensError('auth', 'Connect VibeQ in Settings first.');
  }
  return { endpoint, token };
}

export async function listMembers(): Promise<Member[]> {
  const { endpoint, token } = await requireVibeQ();
  const res = await vibeqFetch(endpoint, '/api/members', token);
  if (!res.ok) throw new LensError('internal', `VibeQ members failed (HTTP ${res.status})`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  return data
    .filter((m): m is { id: string; name: string } => Boolean(m && typeof m.id === 'string' && typeof m.name === 'string'))
    .map((m) => ({ id: m.id, name: m.name }));
}

export async function getFiling(reviewId: number): Promise<Filing | null> {
  const attempt = await getFilingAttempt(reviewId);
  if (!attempt) return null;
  return {
    review: reviewId,
    taskUrl: attempt.receipt?.taskUrl ?? null,
    missingFiles: attempt.receipt?.missingAttachments.length ?? 0,
  };
}

function shouldAttachToVibeQ(filename: string): boolean {
  return (
    /^capture-\d+\.lens\.json$/.test(filename) ||
    /^capture-\d+\.rrweb\.json$/.test(filename) ||
    /^capture-\d+-shot-\d+\.webp$/.test(filename) ||
    /^capture-\d+\.png$/.test(filename)
  );
}

async function resolveProjectId(pageUrl: string | undefined): Promise<string> {
  if (!pageUrl) return 'lens';
  try {
    const origin = new URL(pageUrl).origin;
    const projects = await listProjects();
    const match = projects.find((p) => p.origins.includes(origin));
    if (match) return `lens-project-${match.id}`;
  } catch {
    // fallback
  }
  return 'lens';
}

export async function fileReview(reviewId: number, assignee: string | null): Promise<Filing> {
  const { endpoint, token } = await requireVibeQ();
  const review = await getReview(reviewId);

  if (inFlightObs.has(review.observation)) {
    throw new LensError('conflict', 'This observation is already being filed to VibeQ.');
  }
  inFlightObs.add(review.observation);

  try {
    const me = await fetchMe(endpoint, token);
    let attempt = await getFilingAttempt(reviewId);

    if (attempt) {
      if (attempt.endpoint !== endpoint) {
        throw badRequest('This review was started against a different VibeQ workspace.');
      }
      if (attempt.memberId && attempt.memberId !== me.id) {
        throw badRequest('This review was started by a different VibeQ account.');
      }
    } else {
      const priorFilings = await listObservationFilings(review.observation);
      const completedPrior = priorFilings
        .filter((f) => f.receipt?.taskUrl)
        .sort((a, b) => b.review - a.review)[0];

      if (completedPrior) {
        if (completedPrior.review > review.id || completedPrior.reviewedRevision > review.revision) {
          throw badRequest('A newer review of this observation is already filed.');
        }
        if (completedPrior.endpoint !== endpoint) {
          throw badRequest('Earlier filing belongs to a different VibeQ workspace.');
        }
      }

      const installId = await getInstallId();
      const observationUuid = await uuidv5(installId, `observation:${review.observation}`);
      const projectId = completedPrior?.projectId ?? (await resolveProjectId(review.items[0]?.pageUrl));
      const vibeqRevision = completedPrior
        ? Math.max(completedPrior.vibeqRevision, review.revision) + 1
        : review.revision;

      attempt = {
        review: review.id,
        observation: review.observation,
        reviewedRevision: review.revision,
        endpoint,
        projectId,
        submissionId: crypto.randomUUID(),
        observationUuid,
        vibeqRevision,
        memberId: me.id,
        receipt: null,
      };
      await saveFilingAttempt(attempt);
    }

    // Reconcile existing receipt if any
    const checkRes = await vibeqFetch(endpoint, `/api/capture/v1/submissions/${encodeURIComponent(attempt.submissionId)}`, token);
    if (checkRes.ok) {
      const existing = (await checkRes.json()) as StoredFilingAttempt['receipt'];
      if (existing) {
        attempt.receipt = existing;
        await saveFilingAttempt(attempt);
        if (existing.taskUrl && (!existing.missingAttachments || existing.missingAttachments.length === 0)) {
          return { review: review.id, taskUrl: existing.taskUrl, missingFiles: 0 };
        }
      }
    }

    // Materialize attachments
    const bundle = await buildReviewBundle(review);
    const attachedFiles: Array<{
      id: string;
      filename: string;
      contentType: string;
      sha256: string;
      bytes: Uint8Array<ArrayBuffer>;
    }> = [];

    for (const [filename, entry] of bundle.files) {
      if (!shouldAttachToVibeQ(filename)) continue;
      if (entry.bytes.byteLength > MAX_STAGE_SIZE) continue;
      const sha256 = await sha256Hex(entry.bytes);
      const id = await uuidv5(attempt.submissionId, filename);
      attachedFiles.push({ id, filename, contentType: entry.contentType, sha256, bytes: entry.bytes });
      if (attachedFiles.length >= 64) break;
    }

    const neededIds =
      attempt.receipt && attempt.receipt.missingAttachments.length > 0
        ? new Set(attempt.receipt.missingAttachments)
        : null;
    const toStage = neededIds ? attachedFiles.filter((f) => neededIds.has(f.id)) : attachedFiles;

    // Stage files in parallel batches of 6
    const stagedAttachments: Array<{ id: string; key: string }> = [];
    for (let i = 0; i < toStage.length; i += MAX_STAGE_CONCURRENCY) {
      const batch = toStage.slice(i, i + MAX_STAGE_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (file) => {
          const form = new FormData();
          form.append('file', new Blob([file.bytes], { type: file.contentType }), file.filename);
          const res = await vibeqFetch(endpoint, '/api/attachments/stage', token, { method: 'POST', body: form });
          if (!res.ok) throw new LensError('internal', `Staging ${file.filename} failed (HTTP ${res.status})`);
          const data = (await res.json()) as { stagedKey?: string };
          if (!data.stagedKey) throw new LensError('internal', `VibeQ returned no stagedKey for ${file.filename}`);
          return { id: file.id, key: data.stagedKey };
        }),
      );
      stagedAttachments.push(...results);
    }

    const tags = ['lens', ...cleanTags(review.tags.filter((t) => t !== 'lens'))];
    const payload = {
      submissionId: attempt.submissionId,
      observationId: attempt.observationUuid,
      revision: attempt.vibeqRevision,
      projectId: attempt.projectId,
      title: review.title.trim().slice(0, 500) || 'Bug report',
      markdown: bundle.reportMarkdown.slice(0, MAX_MARKDOWN_LEN),
      ...(assignee ? { assigneeId: assignee } : {}),
      reviewed: true,
      evidenceManifest: attachedFiles.map((f) => ({
        id: f.id,
        filename: f.filename,
        contentType: f.contentType,
        sha256: f.sha256,
      })),
      tags,
      stagedAttachments,
    };

    const submitRes = await vibeqFetch(endpoint, '/api/capture/v1/submissions', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!submitRes.ok) {
      const errText = await submitRes.text().catch(() => '');
      throw new LensError('internal', `VibeQ submission failed (HTTP ${submitRes.status}): ${errText.slice(0, 200)}`);
    }

    const receipt = (await submitRes.json()) as NonNullable<StoredFilingAttempt['receipt']>;
    if (!receipt.taskId || !SAFE_TASK_ID.test(receipt.taskId)) {
      throw new LensError('internal', 'VibeQ returned an invalid taskId');
    }
    attempt.receipt = {
      ...receipt,
      missingAttachments: Array.isArray(receipt.missingAttachments) ? receipt.missingAttachments : [],
    };
    await saveFilingAttempt(attempt);

    return {
      review: review.id,
      taskUrl: attempt.receipt.taskUrl ?? null,
      missingFiles: attempt.receipt.missingAttachments.length,
    };
  } finally {
    inFlightObs.delete(review.observation);
  }
}

export async function startSirvant(reviewId: number): Promise<SirvantRun> {
  const { endpoint, token } = await requireVibeQ();
  const attempt = await getFilingAttempt(reviewId);
  const taskId = attempt?.receipt?.taskId;
  if (!taskId || !SAFE_TASK_ID.test(taskId)) {
    throw badRequest('File the review to VibeQ before starting Sirvant.');
  }
  const res = await vibeqFetch(endpoint, `/api/agent/tasks/${encodeURIComponent(taskId)}/river-work`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'work', invoked_from: 'lens', extra_args: [] }),
  });
  if (res.status === 403) {
    throw new LensError('auth', 'Sirvant is available to VibeQ operators only.');
  }
  if (!res.ok && res.status !== 409) {
    throw new LensError('internal', `Sirvant failed to start (HTTP ${res.status})`);
  }
  const body = (await res.json().catch(() => ({}))) as { session?: { id?: string } };
  return {
    sessionId: body.session?.id ?? taskId,
    alreadyRunning: res.status === 409,
  };
}

export interface DuplicateCandidate {
  id: string;
  title: string;
  status: string;
  description: string;
  similarity: number;
}

export async function findDuplicates(
  observationId: number,
  judge?: (title: string, findings: string[], candidates: DuplicateCandidate[]) => Promise<Map<string, string> | null>,
): Promise<Duplicate[]> {
  const { endpoint, token } = await requireVibeQ();
  const obs = await getObservation(observationId);
  const priorFilings = await listObservationFilings(observationId);
  const ownTaskIds = new Set(priorFilings.map((f) => f.receipt?.taskId).filter(Boolean));

  const { findings } = splitFindingsBlock(obs.notes);
  const queries = [obs.title, ...findings].map((q) => q.trim()).filter(Boolean).slice(0, 6);

  const best = new Map<string, DuplicateCandidate>();
  for (const q of queries) {
    const res = await vibeqFetch(endpoint, `/api/tasks/similar?limit=5&title=${encodeURIComponent(q)}`, token);
    if (!res.ok) continue;
    const data = (await res.json().catch(() => null)) as { results?: DuplicateCandidate[] } | null;
    for (const item of data?.results ?? []) {
      if (!item?.id || ownTaskIds.has(item.id)) continue;
      const prev = best.get(item.id);
      if (!prev || item.similarity > prev.similarity) best.set(item.id, item);
    }
  }

  const candidates = [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, 8);
  if (candidates.length === 0) return [];

  let judged: Map<string, string> | null = null;
  if (judge) {
    try {
      judged = await judge(obs.title, findings, candidates);
    } catch {
      judged = null;
    }
  }

  const out: Duplicate[] = [];
  for (const c of candidates) {
    const reason = judged?.get(c.id);
    if (reason) {
      out.push({
        taskId: c.id,
        title: c.title,
        status: c.status,
        url: `${endpoint}/?task=${encodeURIComponent(c.id)}`,
        similarity: c.similarity,
        verdict: 'same',
        reason,
      });
    } else if (c.similarity >= (judged ? 0.5 : 0.3)) {
      out.push({
        taskId: c.id,
        title: c.title,
        status: c.status,
        url: `${endpoint}/?task=${encodeURIComponent(c.id)}`,
        similarity: c.similarity,
        verdict: 'maybe',
        reason: `${Math.round(c.similarity * 100)}% similar title`,
      });
    }
  }
  return out;
}
