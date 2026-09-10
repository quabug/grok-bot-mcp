/**
 * RFC 7523 private_key_jwt client authentication helpers for CIMD clients.
 * Fetches JWKS (https only) with a short TTL cache and verifies client_assertion JWTs.
 */
import { createLocalJWKSet, jwtVerify, decodeProtectedHeader, errors as joseErrors } from 'jose';

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const ASYMMETRIC_ALGS = new Set([
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
  'EdDSA',
]);
const CLOCK_SKEW_SEC = 60;
const JWKS_CACHE_TTL_MS = 60_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;

/** @type {Map<string, { expiresAt: number, jwks: object }>} */
const jwksCache = new Map();

export { ASSERTION_TYPE, ASYMMETRIC_ALGS, CLOCK_SKEW_SEC };

/**
 * Acceptable audiences for client_assertion (token endpoint URL variants).
 * @param {string} publicBase no trailing slash
 * @returns {string[]}
 */
export function tokenEndpointAudiences(publicBase) {
  const base = publicBase.replace(/\/$/, '');
  const token = `${base}/token`;
  return [token, `${token}/`, base, `${base}/`];
}

/**
 * @param {string} jwksUri
 * @returns {Promise<object>}
 */
async function fetchJwks(jwksUri) {
  let url;
  try {
    url = new URL(jwksUri);
  } catch {
    throw new Error('Invalid jwks_uri');
  }
  if (url.protocol !== 'https:') {
    throw new Error('jwks_uri must use https');
  }

  const cached = jwksCache.get(url.href);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.jwks;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), JWKS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.href, {
      method: 'GET',
      redirect: 'error',
      signal: ac.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
    }
    const jwks = await res.json();
    if (!jwks || !Array.isArray(jwks.keys)) {
      throw new Error('JWKS document missing keys');
    }
    jwksCache.set(url.href, { jwks, expiresAt: Date.now() + JWKS_CACHE_TTL_MS });
    return jwks;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a jose JWKS key set from client metadata (jwks_uri or inline jwks).
 * @param {{ jwks_uri?: string, jwks?: { keys: object[] } }} client
 */
export async function getClientJwkSet(client) {
  if (client.jwks_uri) {
    const jwks = await fetchJwks(client.jwks_uri);
    return createLocalJWKSet(jwks);
  }
  if (client.jwks && Array.isArray(client.jwks.keys)) {
    return createLocalJWKSet(client.jwks);
  }
  throw new Error('Client has neither jwks_uri nor jwks');
}

/**
 * Verify a private_key_jwt client_assertion per RFC 7523.
 *
 * @param {object} opts
 * @param {string} opts.assertion JWT
 * @param {string} [opts.assertionType]
 * @param {string} opts.clientId expected client_id (iss/sub)
 * @param {object} opts.client OAuth client metadata (must include jwks_uri or jwks)
 * @param {string[]} opts.audiences acceptable aud values (token endpoint URLs)
 * @returns {Promise<import('jose').JWTPayload>}
 */
export async function verifyClientAssertion({ assertion, assertionType, clientId, client, audiences }) {
  if (!assertion || typeof assertion !== 'string') {
    throw new Error('client_assertion is required');
  }
  if (
    assertionType != null &&
    assertionType !== '' &&
    assertionType !== ASSERTION_TYPE
  ) {
    throw new Error(`Unsupported client_assertion_type: ${assertionType}`);
  }
  if (!clientId) {
    throw new Error('client_id is required');
  }

  let header;
  try {
    header = decodeProtectedHeader(assertion);
  } catch {
    throw new Error('client_assertion is not a valid JWT');
  }
  if (!header.alg || !ASYMMETRIC_ALGS.has(header.alg)) {
    throw new Error(`Unsupported or missing JWT alg: ${header.alg || '(none)'}`);
  }
  if (header.alg === 'none' || String(header.alg).startsWith('HS')) {
    throw new Error('Symmetric/none JWT algorithms are not allowed');
  }

  const jwkSet = await getClientJwkSet(client);

  let payload;
  try {
    const result = await jwtVerify(assertion, jwkSet, {
      algorithms: [...ASYMMETRIC_ALGS],
      audience: audiences,
      issuer: clientId,
      subject: clientId,
      clockTolerance: CLOCK_SKEW_SEC,
      maxTokenAge: `${24 * 60 * 60}s`,
    });
    payload = result.payload;
  } catch (err) {
    const msg =
      err instanceof joseErrors.JOSEError ? err.message : err?.message || 'JWT verification failed';
    throw new Error(`client_assertion invalid: ${msg}`);
  }

  // jose already checks iss/sub/aud/exp; re-assert iss==sub==client_id for clarity
  if (payload.iss !== clientId || payload.sub !== clientId) {
    throw new Error('client_assertion iss/sub must equal client_id');
  }
  if (payload.exp == null) {
    throw new Error('client_assertion must include exp');
  }

  return payload;
}

/**
 * Express middleware: when the resolved client uses private_key_jwt, require and
 * verify client_assertion before mcp-oauth-server's authenticateClient runs.
 * authenticateClient only checks client_secret, so without this a CIMD client
 * advertising private_key_jwt would be treated as a public client.
 *
 * @param {object} opts
 * @param {(clientId: string) => Promise<object|undefined>} opts.getClient
 * @param {string} opts.publicBase PUBLIC_BASE_URL without trailing slash
 */
export function privateKeyJwtMiddleware({ getClient, publicBase }) {
  const audiences = tokenEndpointAudiences(publicBase);

  return async function privateKeyJwtAuth(req, res, next) {
    if (req.method !== 'POST') {
      return next();
    }

    const body = req.body || {};
    const assertion = body.client_assertion;
    const assertionType = body.client_assertion_type;
    const clientId = body.client_id;

    // No client_id yet — let the library return its usual invalid_request/invalid_client.
    if (!clientId || typeof clientId !== 'string') {
      return next();
    }

    try {
      const client = await getClient(clientId);
      if (!client) {
        return next();
      }

      const method = client.token_endpoint_auth_method || 'none';
      if (method !== 'private_key_jwt') {
        return next();
      }

      await verifyClientAssertion({
        assertion,
        assertionType,
        clientId,
        client,
        audiences,
      });
      // Mark so handlers / logs can see auth succeeded; library still sets req.client.
      req.privateKeyJwtVerified = true;
      return next();
    } catch (err) {
      const description = err?.message || 'client authentication failed';
      console.error('[oauth-gateway] private_key_jwt:', description);
      return res.status(400).json({
        error: 'invalid_client',
        error_description: description,
      });
    }
  };
}
