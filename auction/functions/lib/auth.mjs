// Verifies the Cognito ID token the browser sends in x-auth-token (CloudFront's
// OAC signature takes the Authorization header). Plain node:crypto, so the
// function ships without dependencies.

import { createPublicKey, createVerify } from 'node:crypto';
import { unauthorized } from './http.mjs';

let issuer = null;
let keys = null;          // Map kid -> KeyObject
let fetchedAt = 0;

const issuerUrl = () => issuer
  ?? `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.USER_POOL_ID}`;

async function loadKeys(force) {
  // A token with an unknown kid triggers at most one refetch a minute.
  if (keys && (!force || Date.now() - fetchedAt < 60_000)) return keys;
  const res = await fetch(`${issuerUrl()}/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys: jwks } = await res.json();
  keys = new Map(jwks.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
  fetchedAt = Date.now();
  return keys;
}

/** Tests only: trust these keys and this issuer instead of Cognito's. */
export function useTestKeys(testIssuer, jwks) {
  issuer = testIssuer;
  keys = new Map(jwks.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
  fetchedAt = Date.now();
}

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** Returns the user, or null when no token was sent. Throws 401 on a bad token. */
export async function authenticate(headers) {
  const token = headers?.['x-auth-token']?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const [h, p, s] = token.split('.');
    const header = decode(h);
    if (header.alg !== 'RS256') throw new Error('alg');
    let key = (await loadKeys(false)).get(header.kid);
    if (!key) key = (await loadKeys(true)).get(header.kid);
    if (!key) throw new Error('kid');
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(key, Buffer.from(s, 'base64url'));
    if (!ok) throw new Error('signature');
    const claims = decode(p);
    // The ID token carries the email. Pinning the issuer pins the user pool.
    if (claims.iss !== issuerUrl() || claims.token_use !== 'id') throw new Error('claims');
    if (!(claims.exp * 1000 > Date.now())) throw new Error('expired');
    const groups = claims['cognito:groups'] ?? [];
    return {
      uid: claims.sub,
      email: claims.email ?? '',
      name: claims.name || (claims.email ?? '').split('@')[0] || 'user',
      admin: groups.includes('admin'),
    };
  } catch {
    throw unauthorized();
  }
}
