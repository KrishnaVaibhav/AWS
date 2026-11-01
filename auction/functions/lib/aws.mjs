// SigV4-signed calls to AppSync Events (publish) and EventBridge Scheduler,
// with plain fetch + node:crypto, using the function's role credentials.

import { createHash, createHmac } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest();

const amzDateOf = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');

function signingKey(date, region, service) {
  let key = hmac(`AWS4${process.env.AWS_SECRET_ACCESS_KEY}`, date);
  for (const part of [region, service, 'aws4_request']) key = hmac(key, part);
  return key;
}

async function signedFetch({ host, path, body, service, region = process.env.AWS_REGION }) {
  const amzDate = amzDateOf(new Date());
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers = {
    'content-type': 'application/json',
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (process.env.AWS_SESSION_TOKEN) headers['x-amz-security-token'] = process.env.AWS_SESSION_TOKEN;
  const names = Object.keys(headers).sort();
  const canonical = [
    'POST', path, '',
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(date, region, service)).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${scope}, `
    + `SignedHeaders=${names.join(';')}, Signature=${signature}`;
  delete headers.host; // fetch sets it from the URL
  const res = await fetch(`https://${host}${path}`, { method: 'POST', headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${service} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Publishes events (plain objects) to AppSync Events channels.
 * messages: [{ channel, event }]. Batches of up to 5 per channel per request.
 * No EVENTS_HTTP (tests, local runs) = no-op.
 */
export async function publish(messages) {
  const host = process.env.EVENTS_HTTP;
  if (!host || !messages.length) return;
  const byChannel = new Map();
  for (const { channel, event } of messages) {
    if (!byChannel.has(channel)) byChannel.set(channel, []);
    byChannel.get(channel).push(JSON.stringify(event));
  }
  const calls = [];
  for (const [channel, events] of byChannel) {
    for (let i = 0; i < events.length; i += 5) {
      const body = JSON.stringify({ channel, events: events.slice(i, i + 5) });
      calls.push(signedFetch({ host, path: '/event', body, service: 'appsync' }));
    }
  }
  const results = await Promise.allSettled(calls);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) console.error(JSON.stringify({ msg: 'publish failed', count: failed.length, error: String(failed[0].reason) }));
}

/**
 * One-time schedule that invokes the closer for an item at `at` (ms). The
 * schedule deletes itself after it runs. No SCHEDULE_GROUP = no-op; the
 * every-minute cron sweep closes items either way.
 */
export async function scheduleClose(iid, at) {
  const group = process.env.SCHEDULE_GROUP;
  if (!group) return;
  // Round up to the next whole second, never less than 5 s ahead.
  const when = new Date(Math.ceil(Math.max(at + 1000, Date.now() + 5000) / 1000) * 1000);
  const name = `close-${iid}-${when.getTime()}`;
  const body = JSON.stringify({
    GroupName: group,
    ScheduleExpression: `at(${when.toISOString().slice(0, 19)})`,
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: 'OFF' },
    ActionAfterCompletion: 'DELETE',
    Target: {
      Arn: process.env.CLOSER_ARN,
      RoleArn: process.env.SCHEDULER_ROLE_ARN,
      Input: JSON.stringify({ iid }),
      RetryPolicy: { MaximumRetryAttempts: 5, MaximumEventAgeInSeconds: 3600 },
    },
  });
  try {
    await signedFetch({
      host: `scheduler.${process.env.AWS_REGION}.amazonaws.com`,
      path: `/schedules/${name}`,
      body,
      service: 'scheduler',
    });
  } catch (err) {
    // Not fatal: the cron sweep closes overdue items within a minute.
    if (!/ConflictException/.test(String(err))) console.error(JSON.stringify({ msg: 'schedule failed', iid, error: String(err) }));
  }
}

/**
 * Presigned S3 POST for one browser upload: exact key, size cap, 15 minutes.
 * The browser posts a form with `fields` plus the file to `url`.
 */
export function presignPost({ bucket, key, maxBytes, expiresSec = 900, now = new Date() }) {
  const region = process.env.AWS_REGION;
  const amzDate = amzDateOf(now);
  const date = amzDate.slice(0, 8);
  const credential = `${process.env.AWS_ACCESS_KEY_ID}/${date}/${region}/s3/aws4_request`;
  const fields = {
    key,
    'x-amz-algorithm': 'AWS4-HMAC-SHA256',
    'x-amz-credential': credential,
    'x-amz-date': amzDate,
  };
  if (process.env.AWS_SESSION_TOKEN) fields['x-amz-security-token'] = process.env.AWS_SESSION_TOKEN;
  const policy = Buffer.from(JSON.stringify({
    expiration: new Date(now.getTime() + expiresSec * 1000).toISOString(),
    conditions: [{ bucket }, ['content-length-range', 1, maxBytes], ...Object.entries(fields).map(([k, v]) => ({ [k]: v }))],
  })).toString('base64');
  fields.policy = policy;
  fields['x-amz-signature'] = createHmac('sha256', signingKey(date, region, 's3')).update(policy).digest('hex');
  return { url: `https://${bucket}.s3.${region}.amazonaws.com/`, fields };
}
