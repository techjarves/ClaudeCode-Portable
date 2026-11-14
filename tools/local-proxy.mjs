#!/usr/bin/env node
/**
 * Local speed proxy for Ollama.
 *
 *   Claude Code -> 127.0.0.1:11435 (this proxy) -> 127.0.0.1:11434 (Ollama)
 *
 * CPU-only inference is dominated by the system prompt: Claude Code sends
 * roughly 10k tokens of tool instructions before the first user message. This
 * proxy trims that block to ~300 tokens and leaves the conversation untouched.
 *
 * Both protocols are handled because Claude Code reaches Ollama through its
 * Anthropic-compatible endpoint (/v1/messages), while other clients use
 * /chat/completions.
 *
 * Output goes to data/logs/proxy.log only - never stdout/stderr, so a running
 * terminal UI is not corrupted.
 */
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGS } from '../lib/paths.mjs';

export const PROXY_PORT = Number(process.env.PORTABLE_PROXY_PORT || 11435);
export const OLLAMA_HOST = process.env.PORTABLE_OLLAMA_HOST || '127.0.0.1';
export const OLLAMA_PORT = Number(process.env.PORTABLE_OLLAMA_PORT || 11434);
// A remote server may only speak TLS. Forwarding plaintext to it just fails.
export const OLLAMA_SECURE = process.env.PORTABLE_OLLAMA_SECURE === '1';
export const MAX_SYSTEM_CHARS = Number(process.env.PORTABLE_PROXY_MAX_CHARS || 1200); // ~300 tokens
const TRUNCATION_NOTE = '\n\n[System prompt truncated for local model performance]';

export function log(message) {
  mkdirSync(LOGS, { recursive: true });
  try { appendFileSync(join(LOGS, 'proxy.log'), `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 }); } catch {}
}

/** Keeps a system prompt intact when it is already short, else cuts at a sentence boundary. */
export function trimSystemPrompt(content, maxChars = MAX_SYSTEM_CHARS) {
  if (typeof content !== 'string' || content.length <= maxChars) return content;
  const cut = content.lastIndexOf('. ', maxChars);
  const trimPoint = cut > maxChars * 0.6 ? cut + 1 : maxChars;
  return content.slice(0, trimPoint).trimEnd() + TRUNCATION_NOTE;
}

function trimTextParts(blocks, maxChars) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map(block => block?.type === 'text' && typeof block.text === 'string' ? { ...block, text: trimSystemPrompt(block.text, maxChars) } : block);
}

/**
 * Anthropic Messages API: `system` is a string or an array of text blocks.
 * Returns the trimmed body plus the number of characters saved.
 */
export function trimAnthropicBody(body, maxChars = MAX_SYSTEM_CHARS) {
  if (!body || typeof body !== 'object' || body.system === undefined) return { body, saved: 0 };
  const before = JSON.stringify(body.system).length;
  const system = typeof body.system === 'string' ? trimSystemPrompt(body.system, maxChars) : trimTextParts(body.system, maxChars);
  const next = { ...body, system };
  return { body: next, saved: Math.max(0, before - JSON.stringify(system).length) };
}

/** OpenAI Chat Completions: system prompts are messages with role "system". */
export function trimOpenAIBody(body, maxChars = MAX_SYSTEM_CHARS) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return { body, saved: 0 };
  const before = JSON.stringify(body.messages).length;
  const messages = body.messages.map(message => {
    if (message?.role !== 'system') return message;
    if (typeof message.content === 'string') return { ...message, content: trimSystemPrompt(message.content, maxChars) };
    return { ...message, content: trimTextParts(message.content, maxChars) };
  });
  const next = { ...body, messages };
  return { body: next, saved: Math.max(0, before - JSON.stringify(messages).length) };
}

function trimRequest(pathname, rawBody) {
  if (pathname.startsWith('/v1/messages')) return trimAnthropicBody(rawBody);
  if (pathname.includes('/chat/completions')) return trimOpenAIBody(rawBody);
  return { body: rawBody, saved: 0 };
}

export function createProxyServer({ upstreamHost = OLLAMA_HOST, upstreamPort = OLLAMA_PORT, upstreamSecure = OLLAMA_SECURE, maxChars = MAX_SYSTEM_CHARS } = {}) {
  const upstreamUrl = `${upstreamSecure ? 'https' : 'http'}://${upstreamHost}:${upstreamPort}`;
  return createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, upstream: upstreamUrl }));
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let payload = raw;
      if (req.method === 'POST' && raw.length) {
        try {
          const parsed = JSON.parse(raw.toString('utf8'));
          const { body } = trimRequest(req.url || '/', parsed);
          if (body !== parsed) {
            payload = Buffer.from(JSON.stringify(body), 'utf8');
            const saved = Math.round(((raw.length - payload.length) / raw.length) * 100);
            if (saved > 0) log(`Trimmed system prompt: ${raw.length} -> ${payload.length} bytes (${saved}% reduction)`);
          }
        } catch {
          payload = raw; // Not JSON: forward untouched.
        }
      }
      const upstream = (upstreamSecure ? httpsRequest : httpRequest)({
        hostname: upstreamHost,
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${upstreamHost}:${upstreamPort}`, 'content-length': payload.length },
      }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res, { end: true });
      });
      upstream.on('error', error => {
        log(`Ollama connection error: ${error.message}`);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Ollama unreachable: ${error.message}` }));
      });
      upstream.end(payload);
    });
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.env.PORTABLE_PROXY_NO_AUTOSTART !== '1') {
  const server = createProxyServer();
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') { log(`Port ${PROXY_PORT} already in use - an existing proxy instance is reused`); process.exit(0); }
    log(`Server error: ${error.message}`);
    process.exit(1);
  });
  server.listen(PROXY_PORT, '127.0.0.1', () => log(`Proxy started on :${PROXY_PORT} -> ${OLLAMA_HOST}:${OLLAMA_PORT}`));
}
