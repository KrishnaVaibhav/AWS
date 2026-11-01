// Shared setup for API tests: env for DynamoDB Local, a fresh table, signed
// test tokens, and a call() that drives the real Lambda handler.
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';

export const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

export function setupEnv(prefix) {
  Object.assign(process.env, {
    DYNAMODB_ENDPOINT: ENDPOINT,
    TABLE_NAME: `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    STAGE: 'test',
    MEDIA_BUCKET: 'test-media-bucket',
  });
  delete process.env.EVENTS_HTTP;
  delete process.env.SCHEDULE_GROUP;
}

export async function reachable() {
  const ok = await fetch(ENDPOINT).then(() => true, () => false);
  if (!ok && process.env.REQUIRE_DYNAMODB) throw new Error(`REQUIRE_DYNAMODB is set but nothing answers at ${ENDPOINT}`);
  return ok;
}

export async function createTable(t) {
  const { DynamoDBClient, CreateTableCommand, DeleteTableCommand } = await import('@aws-sdk/client-dynamodb');
  const ddb = new DynamoDBClient({ endpoint: ENDPOINT });
  const S = (n) => ({ AttributeName: n, AttributeType: 'S' });
  const gsi = (n) => ({ IndexName: n, KeySchema: [{ AttributeName: `${n}PK`, KeyType: 'HASH' }, { AttributeName: `${n}SK`, KeyType: 'RANGE' }], Projection: { ProjectionType: 'KEYS_ONLY' } });
  await ddb.send(new CreateTableCommand({
    TableName: process.env.TABLE_NAME,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK'].map(S),
    KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    GlobalSecondaryIndexes: [gsi('GSI1'), gsi('GSI2')],
  }));
  t.after(() => ddb.send(new DeleteTableCommand({ TableName: process.env.TABLE_NAME })));
}

/** Users, tokens and a call() bound to the handler. */
export async function client(names) {
  const { handler } = await import('../functions/api/index.mjs');
  const { useTestKeys } = await import('../functions/lib/auth.mjs');
  const issuer = 'https://issuer.test/pool';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  useTestKeys(issuer, [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }]);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const users = Object.fromEntries(names.map((name) => [name, { uid: randomUUID(), name, email: `${name}@example.test`, admin: false }]));
  const tokenFor = (u) => {
    const unsigned = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({
      sub: u.uid, email: u.email, name: u.name, iss: issuer, token_use: 'id', exp: Math.floor(Date.now() / 1000) + 3600,
    })}`;
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')}`;
  };
  async function call(method, path, { as, body, qs } = {}) {
    const res = await handler({
      requestContext: { http: { method } },
      rawPath: path,
      queryStringParameters: qs,
      headers: as ? { 'x-auth-token': tokenFor(users[as]) } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const parsed = res.headers['content-type'].startsWith('application/json') ? JSON.parse(res.body) : res.body;
    return { status: res.statusCode, body: parsed };
  }
  return { users, call };
}
