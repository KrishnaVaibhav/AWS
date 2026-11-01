// Web Push with no dependencies: VAPID (RFC 8292) and aes128gcm payload
// encryption (RFC 8291), on node:crypto. The VAPID key pair is made on first
// use and kept in the table (CONFIG / VAPID), so it is deleted with the stack.

import {
  createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign,
} from 'node:crypto';
import { keys, get, put } from './db.mjs';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// Push services the browsers use. Anything else is refused, so a crafted
// subscription can't make the function call arbitrary URLs.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

export function validEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && PUSH_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

let cached = null;

/** { publicKey (base64url, uncompressed P-256 point), privateJwk } */
export async function vapidKeys() {
  if (cached) return cached;
  let row = await get(keys.config('VAPID'));
  if (!row) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    const publicKey = b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
    try {
      await put({ ...keys.config('VAPID'), publicKey, privateJwk: jwk, createdAt: Date.now() }, { ConditionExpression: 'attribute_not_exists(PK)' });
    } catch (err) {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
    }
    row = await get(keys.config('VAPID')); // whoever won the race
  }
  cached = { publicKey: row.publicKey, privateJwk: row.privateJwk };
  return cached;
}

/** Authorization header value for one push service. */
export function vapidHeader(endpoint, vapid, contact, now = Date.now()) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: contact }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey({ key: vapid.privateJwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

/**
 * RFC 8291 aes128gcm: ECDH with the browser's key, HKDF with its auth secret,
 * one record. Returns the request body.
 */
export function encrypt(plaintext, p256dh, auth, { salt = randomBytes(16), ecdh = null } = {}) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const local = ecdh ?? createECDH('prime256v1');
  if (!ecdh) local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);

  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/**
 * Sends one notification. Returns 'ok', 'gone' (the subscription expired:
 * delete it) or 'failed'.
 */
export async function sendPush(subscription, payload, { contact = process.env.PUSH_CONTACT ?? 'mailto:admin@example.com' } = {}) {
  if (!validEndpoint(subscription.endpoint)) return 'gone';
  const vapid = await vapidKeys();
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidHeader(subscription.endpoint, vapid, contact),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '86400',
      urgency: 'normal',
    },
    body: encrypt(JSON.stringify(payload), subscription.keys.p256dh, subscription.keys.auth),
  }).catch(() => null);
  if (!res) return 'failed';
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'ok' : 'failed';
}
