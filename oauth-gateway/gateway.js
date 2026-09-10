#!/usr/bin/env node
/**
 * OAuth 2.1 gateway in front of local chatgpt-local-mcp (Streamable HTTP).
 * - Owner password login at /consent
 * - DCR + PKCE + protected-resource metadata
 * - /mcp requires Bearer token; proxies to upstream MCP on 127.0.0.1
 */
import express from 'express';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import httpProxy from 'http-proxy';
import {
  OAuthServer,
  mcpAuthRouter,
  requireBearerAuth,
  getOAuthProtectedResourceMetadataUrl,
  authenticateHandler,
} from 'mcp-oauth-server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SECRETS = path.join(ROOT, 'secrets');

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
if (!PUBLIC_BASE || !PUBLIC_BASE.startsWith('https://')) {
  console.error('PUBLIC_BASE_URL must be set to an https:// base (no trailing slash)');
  process.exit(1);
}

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 3860);
const UPSTREAM = process.env.UPSTREAM_MCP || 'http://127.0.0.1:3851';
const HASH_PATH = process.env.OWNER_PASSWORD_HASH_FILE || path.join(SECRETS, 'owner_password.bcrypt');

const hash = fs.readFileSync(HASH_PATH, 'utf8').trim();
if (!hash) {
  console.error('Missing owner password hash at', HASH_PATH);
  process.exit(1);
}

const issuerUrl = new URL(PUBLIC_BASE + '/');
const mcpServerUrl = new URL(PUBLIC_BASE + '/mcp');
const authorizationUrl = new URL(PUBLIC_BASE + '/consent');

const oauthServer = new OAuthServer({
  issuerUrl,
  authorizationUrl,
  resourceServerUrl: mcpServerUrl,
  scopesSupported: ['mcp:tools'],
  grantTypes: ['authorization_code', 'refresh_token'],
  dynamicClientRegistration: true,
  clientIdMetadataDocuments: {
    // Allow ChatGPT / OpenAI client metadata documents; reject everything else.
    validateClientIdUrl: (url) => {
      const host = url.hostname.toLowerCase();
      return (
        host === 'chatgpt.com' ||
        host.endsWith('.chatgpt.com') ||
        host === 'openai.com' ||
        host.endsWith('.openai.com') ||
        host === 'platform.openai.com'
      );
    },
  },
  // ChatGPT sends resource; keep strict for security.
  strictResource: true,
  accessTokenLifetime: 3600,
  refreshTokenLifetime: 14 * 24 * 3600,
});

const app = express();
const proxy = httpProxy.createProxyServer({
  target: UPSTREAM,
  changeOrigin: true,
  xfwd: true,
  // Streamable HTTP / SSE needs timeout disabled
  proxyTimeout: 0,
  timeout: 0,
});

proxy.on('error', (err, req, res) => {
  console.error('[proxy]', err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream_unavailable' }));
  }
});

// Trust Cloudflare / proxy headers for correct host
app.set('trust proxy', true);

// OAuth AS + PRM metadata + /authorize /token /register /revoke
app.use(
  mcpAuthRouter({
    provider: oauthServer,
    resourceServerUrl: mcpServerUrl,
    resourceName: 'Grok Bot MCP',
    scopesSupported: ['mcp:tools'],
  })
);

// Health (unauthenticated)
app.get('/health', (_req, res) => {
  res.json({ ok: true, auth: 'oauth2.1', mcp: '/mcp' });
});

// Consent / owner login page
app.get('/consent', (req, res) => {
  const q = req.query;
  const fields = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource'];
  const hidden = fields
    .map((k) => {
      const v = q[k];
      if (v == null || v === '') return '';
      return `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}" />`;
    })
    .join('\n');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Grok Bot — Authorize</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0b0f14;color:#e8eef7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#151b24;border:1px solid #2a3544;border-radius:12px;padding:28px;max-width:420px;width:92%}
  h1{font-size:1.25rem;margin:0 0 8px} p{opacity:.8;font-size:.95rem;line-height:1.4}
  label{display:block;margin:16px 0 6px;font-size:.85rem} input[type=password]{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #3a4658;background:#0b0f14;color:#e8eef7;box-sizing:border-box}
  button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#6d5efc;color:#fff;font-weight:600;cursor:pointer}
  .err{color:#ff8e8e;margin-top:12px;font-size:.9rem}
  .meta{font-size:.75rem;opacity:.55;margin-top:16px;word-break:break-all}
</style></head><body>
<div class="card">
  <h1>Authorize Grok Bot</h1>
  <p>Enter the owner password to allow ChatGPT to use this MCP connector.</p>
  <form method="POST" action="/consent/approve">
    ${hidden}
    <label for="password">Owner password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
    <button type="submit">Allow access</button>
  </form>
  ${q.error ? `<p class="err">${String(q.error).replace(/</g,'&lt;')}</p>` : ''}
  <p class="meta">Resource: ${String(q.resource || mcpServerUrl.href).replace(/</g,'&lt;')}</p>
</div></body></html>`);
});

function consentRedirect(req, errorMsg) {
  const params = new URLSearchParams();
  for (const k of ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource']) {
    if (req.body?.[k]) params.set(k, String(req.body[k]));
  }
  if (errorMsg) params.set('error', errorMsg);
  return '/consent?' + params.toString();
}

const approve = authenticateHandler({
  provider: oauthServer,
  getUser: async (req) => {
    // Password already verified in middleware; identity is the owner.
    return 'owner';
  },
  rateLimit: { windowMs: 15 * 60 * 1000, max: 30 },
});

async function verifyOwnerPassword(req, res, next) {
  try {
    // Ensure body parsed (authenticateHandler also parses, but we need password first)
    if (!req.body) {
      return res.redirect(consentRedirect(req, 'Missing form body'));
    }
    const password = req.body.password;
    await new Promise((r) => setTimeout(r, 80 + crypto.randomInt(40)));
    if (!password || typeof password !== 'string' || !bcrypt.compareSync(password, hash)) {
      return res.redirect(consentRedirect(req, 'Invalid owner password'));
    }
    delete req.body.password;
    next();
  } catch (err) {
    return res.redirect(consentRedirect(req, err.message || 'Authorization failed'));
  }
}

// authenticateHandler returns a Router mounted at POST /
app.use('/consent/approve', express.urlencoded({ extended: false }), verifyOwnerPassword, approve);

// CORS preflight for MCP
app.options('/mcp', (_req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization,Content-Type,Accept,Mcp-Session-Id,MCP-Protocol-Version,Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  });
  res.sendStatus(204);
});

const bearer = requireBearerAuth({
  verifier: oauthServer,
  requiredScopes: ['mcp:tools'],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
  resource: mcpServerUrl,
});

function proxyMcp(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  proxy.web(req, res, { target: UPSTREAM });
}

// Protect all MCP methods
app.all('/mcp', bearer, proxyMcp);
// /mcp only (streamable HTTP is single endpoint)

const server = http.createServer(app);
// Also proxy websockets if any
server.on('upgrade', (req, socket, head) => {
  // Require Authorization on upgrade is awkward; refuse upgrades without auth header
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: UPSTREAM });
});

server.listen(GATEWAY_PORT, '127.0.0.1', () => {
  console.log(`[oauth-gateway] listening on 127.0.0.1:${GATEWAY_PORT}`);
  console.log(`[oauth-gateway] public base ${PUBLIC_BASE}`);
  console.log(`[oauth-gateway] mcp resource ${mcpServerUrl.href}`);
  console.log(`[oauth-gateway] upstream ${UPSTREAM}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
