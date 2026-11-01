// Local console without AWS: serves web/, runs the real API handler against
// DynamoDB Local, signs in with throwaway test tokens, and closes due items
// every 10 s. Live updates (AppSync) and Web Push are off locally.
//
//   npm run dynamodb   # or DynamoDBLocal.jar on port 8000
//   npm run dev        # http://localhost:5173, sign in as any name
//
// For local testing only: anyone who can reach the port can sign in as anyone.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 5173);
Object.assign(process.env, {
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000',
  TABLE_NAME: process.env.TABLE_NAME ?? 'auction-local',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
  STAGE: 'local',
  MEDIA_BUCKET: 'local-media',
});

const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');
const ddb = new DynamoDBClient({ endpoint: process.env.DYNAMODB_ENDPOINT });
try {
  await ddb.send(new DescribeTableCommand({ TableName: process.env.TABLE_NAME }));
} catch {
  const S = (n) => ({ AttributeName: n, AttributeType: 'S' });
  const gsi = (n) => ({ IndexName: n, KeySchema: [{ AttributeName: `${n}PK`, KeyType: 'HASH' }, { AttributeName: `${n}SK`, KeyType: 'RANGE' }], Projection: { ProjectionType: 'KEYS_ONLY' } });
  await ddb.send(new CreateTableCommand({
    TableName: process.env.TABLE_NAME,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK'].map(S),
    KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    GlobalSecondaryIndexes: [gsi('GSI1'), gsi('GSI2')],
  }));
  console.log(`created table ${process.env.TABLE_NAME}`);
}

const { handler } = await import('../functions/api/index.mjs');
const { useTestKeys } = await import('../functions/lib/auth.mjs');
const { sweepOverdue } = await import('../functions/lib/auction.mjs');

const ISSUER = 'https://local.test/pool';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
useTestKeys(ISSUER, [{ ...publicKey.export({ format: 'jwk' }), kid: 'local', alg: 'RS256' }]);

function tokenFor(name) {
  const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
  const sub = createHash('sha256').update(clean).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const unsigned = `${b64({ alg: 'RS256', kid: 'local' })}.${b64({ sub, email: `${clean}@example.test`, name: clean, iss: ISSUER, token_use: 'id', exp })}`;
  return { token: `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')}`, exp: exp * 1000 };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/config.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ stage: 'local', devLogin: true, eventsRealtime: '', eventsHttp: '', eventsApiKey: '' }));
    }
    if (url.pathname === '/dev/login') {
      const name = url.searchParams.get('name');
      if (!name) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<form><p>Local sign-in (test only). Name: <input name="name" autofocus> <button>Sign in</button></p></form>');
      }
      const { token, exp } = tokenFor(name);
      const session = JSON.stringify({ id: token, exp });
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<script>sessionStorage.setItem('session', ${JSON.stringify(session)}); location.replace('/');</script>`);
    }
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const out = await handler({
        requestContext: { http: { method: req.method } },
        rawPath: url.pathname,
        queryStringParameters: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
        body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
      });
      res.writeHead(out.statusCode, out.headers);
      return res.end(out.body);
    }
    const file = normalize(join(ROOT, 'web', url.pathname === '/' || !extname(url.pathname) ? 'index.html' : url.pathname));
    if (!file.startsWith(join(ROOT, 'web'))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
    return res.end(err.code === 'ENOENT' ? 'not found' : String(err));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`auction console on http://localhost:${PORT} (table ${process.env.TABLE_NAME})`));

setInterval(() => sweepOverdue().catch((err) => console.error('sweep', err.message)), 10_000);
