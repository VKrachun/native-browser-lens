#!/usr/bin/env node
/**
 * Local OpenAI-compatible HTTP bridge for Sirv Lens.
 * Exposes local Claude Code (and Codex CLI if installed) on http://127.0.0.1:4000/v1
 * so Sirv Lens can draft titles, findings, splits, and duplicate checks using your local CLI login.
 *
 * Usage:
 *   node scripts/lens-local-proxy.mjs
 *
 * Env vars:
 *   PORT=4000                 Port to bind on 127.0.0.1 (default: 4000)
 *   LENS_PROXY_TOKEN=...      Optional bearer token to require on /v1/* requests
 *   CLAUDE_BIN=claude         Path to Claude Code binary
 *   CODEX_BIN=codex           Path to Codex CLI binary
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4000);
const TOKEN = (process.env.LENS_PROXY_TOKEN || '').trim();
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

function hasBin(bin) {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000 });
  return r.status === 0;
}

const HAS_CLAUDE = hasBin(CLAUDE_BIN);
const HAS_CODEX = hasBin(CODEX_BIN);

const MODELS = [
  ...(HAS_CLAUDE
    ? [
        { id: 'claude-haiku', cli: 'claude', modelArg: 'haiku' },
        { id: 'claude-sonnet', cli: 'claude', modelArg: 'sonnet' },
        { id: 'claude-opus', cli: 'claude', modelArg: 'opus' },
      ]
    : []),
  ...(HAS_CODEX ? [{ id: 'codex', cli: 'codex', modelArg: null }] : []),
];

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') parts.push(item);
    else if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join('\n\n');
}

function extractImages(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const item of content) {
    const url = item?.image_url?.url;
    if (item?.type === 'image_url' && typeof url === 'string') {
      const m = url.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
      if (m) images.push({ ext: m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase(), data: m[2] });
    }
  }
  return images;
}

function splitMessages(messages) {
  const systemParts = [];
  const userParts = [];
  const images = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const text = extractText(msg.content).trim();
    if (msg.role === 'system') {
      if (text) systemParts.push(text);
    } else {
      const prefix = msg.role === 'assistant' ? 'Assistant:\n' : '';
      if (text) userParts.push(`${prefix}${text}`);
      images.push(...extractImages(msg.content));
    }
  }
  return {
    system: systemParts.join('\n\n'),
    user: userParts.join('\n\n'),
    images,
  };
}

function runClaude(modelArg, system, user) {
  return new Promise((resolve, reject) => {
    const workdir = mkdtempSync(join(tmpdir(), 'lens-claude-'));
    const args = [
      '-p',
      '--model',
      modelArg || 'haiku',
      '--output-format',
      'text',
      '--no-session-persistence',
      '--tools',
      '',
    ];
    if (system) {
      args.push('--system-prompt', system);
    }
    const env = { ...process.env };
    // Avoid nesting guards if started from inside another Claude Code session.
    delete env.CLAUDECODE;
    const child = spawn(CLAUDE_BIN, args, { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(workdir, { recursive: true, force: true });
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(new Error(`Claude Code timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (err) => done(err));
    child.on('close', (code) => {
      if (code !== 0) {
        done(new Error(`Claude Code exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`));
      } else {
        done(null, stdout.trim());
      }
    });
    child.stdin.end(user);
  });
}

function runCodex(modelArg, system, user, images) {
  return new Promise((resolve, reject) => {
    const workdir = mkdtempSync(join(tmpdir(), 'lens-codex-'));
    const outFile = join(workdir, 'out.txt');
    const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-last-message', outFile];
    if (modelArg) args.push('--model', modelArg);
    for (let i = 0; i < images.length; i += 1) {
      const p = join(workdir, `img-${i}.${images[i].ext}`);
      writeFileSync(p, Buffer.from(images[i].data, 'base64'));
      args.push('--image', p);
    }
    args.push('-');
    const prompt = system ? `${system}\n\n${user}` : user;
    const child = spawn(CODEX_BIN, args, { cwd: workdir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(workdir, { recursive: true, force: true });
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(new Error(`Codex CLI timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (err) => done(err));
    child.on('close', (code) => {
      if (code !== 0) {
        done(new Error(`Codex CLI exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`));
      } else {
        const text = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : stdout.trim();
        done(null, text);
      }
    });
    child.stdin.end(prompt);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function resolveModel(requested) {
  const name = String(requested || '').trim();
  const exact = MODELS.find((m) => m.id === name);
  if (exact) return exact;
  if (HAS_CODEX && /^codex(?::(.+))?$/i.test(name)) {
    const m = name.match(/^codex:(.+)$/i);
    return { id: name, cli: 'codex', modelArg: m ? m[1] : null };
  }
  if (HAS_CLAUDE) {
    if (!name || name === 'default') return MODELS[0];
    return { id: name, cli: 'claude', modelArg: name.replace(/^claude-/i, '') };
  }
  if (HAS_CODEX) {
    return { id: name || 'codex', cli: 'codex', modelArg: name && name !== 'default' ? name : null };
  }
  throw new Error('Neither claude nor codex CLI was found in PATH.');
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (url.pathname === '/health' || url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      service: 'sirv-lens-local-proxy',
      claude: HAS_CLAUDE,
      codex: HAS_CODEX,
      models: MODELS.map((m) => m.id),
    });
  }

  if (TOKEN) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${TOKEN}`) {
      return sendJson(res, 401, { error: { message: 'Invalid bearer token' } });
    }
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return sendJson(res, 200, {
      object: 'list',
      data: MODELS.map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: m.cli,
      })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    try {
      const body = await readJsonBody(req);
      const spec = resolveModel(body.model);
      const { system, user, images } = splitMessages(body.messages);
      if (!user) return sendJson(res, 400, { error: { message: 'Missing user message' } });

      const content =
        spec.cli === 'codex'
          ? await runCodex(spec.modelArg, system, user, images)
          : await runClaude(spec.modelArg, system, user);

      return sendJson(res, 200, {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: spec.id,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
      });
    } catch (error) {
      return sendJson(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  }

  return sendJson(res, 404, { error: { message: `Not found: ${req.method} ${url.pathname}` } });
});

server.listen(PORT, HOST, () => {
  console.log(`Sirv Lens local proxy listening on http://${HOST}:${PORT}/v1`);
  console.log(`Available models: ${MODELS.map((m) => m.id).join(', ') || '(none found in PATH)'}`);
});
