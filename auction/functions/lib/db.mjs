// DynamoDB access. One table; key layout in auction/docs/architecture.md §4.
// The AWS SDK v3 ships with the Lambda Node.js runtime, so nothing is bundled.

import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand, BatchWriteCommand, DynamoDBDocumentClient, GetCommand, PutCommand,
  QueryCommand, TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { conflict } from './http.mjs';

const client = new DynamoDBClient(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {});
export const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
const table = () => process.env.TABLE_NAME;

/** Sortable, channel-safe id: 13-digit ms timestamp + random hex. */
export const newId = (now = Date.now()) => `${String(now).padStart(13, '0')}-${randomBytes(4).toString('hex')}`;

export const keys = {
  auction: (aid) => ({ PK: `AUC#${aid}`, SK: 'META' }),
  item: (aid, iid) => ({ PK: `AUC#${aid}`, SK: `ITEM#${iid}` }),
  state: (iid) => ({ PK: `ITEM#${iid}`, SK: 'STATE' }),
  result: (iid) => ({ PK: `ITEM#${iid}`, SK: 'RESULT' }),
  bid: (iid, bidId) => ({ PK: `ITEM#${iid}`, SK: `BID#${bidId}` }),
  reg: (aid, uid) => ({ PK: `AUC#${aid}`, SK: `REG#${uid}` }),
  balance: (aid, uid) => ({ PK: `AUC#${aid}`, SK: `BAL#${uid}` }),
  ledger: (aid, uid, id) => ({ PK: `AUC#${aid}`, SK: `LEDGER#${uid}#${id}` }),
  log: (aid, id) => ({ PK: `AUC#${aid}`, SK: `LOG#${id}` }),
  chat: (aid, id) => ({ PK: `AUC#${aid}`, SK: `CHAT#${id}` }),
  pending: (aid, bidId) => ({ PK: `AUC#${aid}`, SK: `PENDING#${bidId}` }),
  stat: (aid, day) => ({ PK: `AUC#${aid}`, SK: `STAT#${day}` }),
  sealed: (iid, uid) => ({ PK: `ITEM#${iid}`, SK: `SEALED#${uid}` }),
  offer: (iid, oid) => ({ PK: `ITEM#${iid}`, SK: `OFFER#${oid}` }),
  watcher: (iid, uid) => ({ PK: `ITEM#${iid}`, SK: `WATCHER#${uid}` }),
  watch: (uid, iid) => ({ PK: `USER#${uid}`, SK: `WATCH#${iid}` }),
  bidOn: (uid, iid) => ({ PK: `USER#${uid}`, SK: `BIDON#${iid}` }),
  note: (uid, id) => ({ PK: `USER#${uid}`, SK: `NOTE#${id}` }),
  push: (uid, hash) => ({ PK: `USER#${uid}`, SK: `PUSH#${hash}` }),
  template: (uid, id) => ({ PK: `USER#${uid}`, SK: `TEMPLATE#${id}` }),
  config: (name) => ({ PK: 'CONFIG', SK: name }),
};

export async function get(key, consistent = true) {
  const res = await ddb.send(new GetCommand({ TableName: table(), Key: key, ConsistentRead: consistent }));
  return res.Item;
}

export async function put(item, condition) {
  await ddb.send(new PutCommand({ TableName: table(), Item: item, ...condition }));
}

export async function update(params) {
  const res = await ddb.send(new UpdateCommand({ TableName: table(), ReturnValues: 'ALL_NEW', ...params }));
  return res.Attributes;
}

/** All rows (or up to limit) under PK whose SK starts with prefix. */
export async function query(PK, prefix, { limit, desc = false, after, before, index, consistent = false } = {}) {
  const items = [];
  let ExclusiveStartKey;
  const names = index ? { '#pk': `${index}PK`, '#sk': `${index}SK` } : { '#pk': 'PK', '#sk': 'SK' };
  let cond = '#pk = :pk AND begins_with(#sk, :prefix)';
  const values = { ':pk': PK, ':prefix': prefix };
  if (after != null || before != null) {
    // Range scans keep the prefix by bounding with it: prefix + '￿' sorts after every key.
    cond = '#pk = :pk AND #sk BETWEEN :lo AND :hi';
    delete values[':prefix'];
    values[':lo'] = after != null ? `${prefix}${after}\u0000` : prefix;
    values[':hi'] = before != null ? `${prefix}${before}` : `${prefix}￿`;
  }
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: table(),
      IndexName: index,
      KeyConditionExpression: cond,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ScanIndexForward: !desc,
      ConsistentRead: index ? undefined : consistent,
      Limit: limit ? limit - items.length : undefined,
      ExclusiveStartKey,
    }));
    items.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && (!limit || items.length < limit));
  return items;
}

/** Index query (GSI1/GSI2 are KEYS_ONLY), then fetch the full rows. */
export async function queryIndex(index, pk, { limit, desc = true, lte, gte } = {}) {
  let cond = '#pk = :pk';
  const names = { '#pk': `${index}PK` };
  const values = { ':pk': pk };
  if (lte != null || gte != null) {
    names['#sk'] = `${index}SK`;
    if (lte != null && gte != null) cond += ' AND #sk BETWEEN :gte AND :lte';
    else cond += lte != null ? ' AND #sk <= :lte' : ' AND #sk >= :gte';
    if (lte != null) values[':lte'] = lte;
    if (gte != null) values[':gte'] = gte;
  }
  const res = await ddb.send(new QueryCommand({
    TableName: table(),
    IndexName: index,
    KeyConditionExpression: cond,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ScanIndexForward: !desc,
    Limit: limit,
  }));
  const found = await batchGet(res.Items.map(({ PK, SK }) => ({ PK, SK })));
  return res.Items.map(({ PK, SK }) => found.get(`${PK}|${SK}`)).filter(Boolean);
}

/** Map of "PK|SK" -> row for the keys that exist. */
export async function batchGet(keyList) {
  const out = new Map();
  const unique = [...new Map(keyList.map((k) => [`${k.PK}|${k.SK}`, k])).values()];
  for (let i = 0; i < unique.length; i += 100) {
    let request = { [table()]: { Keys: unique.slice(i, i + 100), ConsistentRead: true } };
    for (let attempt = 0; request && Object.keys(request).length; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      const res = await ddb.send(new BatchGetCommand({ RequestItems: request }));
      for (const row of res.Responses?.[table()] ?? []) out.set(`${row.PK}|${row.SK}`, row);
      request = res.UnprocessedKeys;
      if (attempt > 6) throw new Error('BatchGet kept returning unprocessed keys');
    }
  }
  return out;
}

/** Deletes rows by key, 25 per request, retrying unprocessed ones. */
export async function deleteKeys(keyList) {
  for (let i = 0; i < keyList.length; i += 25) {
    let request = { [table()]: keyList.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
    for (let attempt = 0; request && Object.keys(request).length; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      if (attempt > 6) throw new Error('BatchWrite kept returning unprocessed items');
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: request }));
      request = res.UnprocessedItems;
    }
  }
}

export class TxConflict extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Transaction builder. Each operation carries the reason to report if its
 * condition fails, e.g. 'retry' for a lost optimistic-lock race or
 * 'insufficient_balance'. Throws TxConflict(reason).
 */
export class Tx {
  constructor() {
    this.ops = [];
    this.reasons = [];
  }

  put(item, { condition, names, values, reason = 'conflict' } = {}) {
    this.ops.push({ Put: { TableName: table(), Item: item, ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values } });
    this.reasons.push(reason);
    return this;
  }

  update(key, { set, add, remove, condition, names, values, reason = 'conflict' }) {
    const parts = [];
    if (set?.length) parts.push(`SET ${set.join(', ')}`);
    if (add?.length) parts.push(`ADD ${add.join(', ')}`);
    if (remove?.length) parts.push(`REMOVE ${remove.join(', ')}`);
    this.ops.push({ Update: { TableName: table(), Key: key, UpdateExpression: parts.join(' '), ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values } });
    this.reasons.push(reason);
    return this;
  }

  delete(key, { condition, names, values, reason = 'conflict' } = {}) {
    this.ops.push({ Delete: { TableName: table(), Key: key, ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values } });
    this.reasons.push(reason);
    return this;
  }

  async run() {
    if (!this.ops.length) return;
    for (const op of this.ops) {
      const body = Object.values(op)[0];
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    }
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: this.ops }));
    } catch (err) {
      if (err.name !== 'TransactionCanceledException') throw err;
      const codes = (err.CancellationReasons ?? []).map((r) => r.Code);
      const i = codes.indexOf('ConditionalCheckFailed');
      if (i >= 0) throw new TxConflict(this.reasons[i]);
      if (codes.includes('TransactionConflict')) throw new TxConflict('retry');
      throw err;
    }
  }
}

/** Runs fn up to `attempts` times while it loses optimistic-lock races. */
export async function withRetry(fn, attempts = 4) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TxConflict) || err.reason !== 'retry') throw err;
      if (i >= attempts) throw conflict('busy', 'Too many bids at once. Try again.');
      await new Promise((r) => setTimeout(r, 20 * i + Math.random() * 30));
    }
  }
}
