// Responses, errors and input checks shared by the API routes.

export class HttpError extends Error {
  constructor(status, code, message = code, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new HttpError(400, code, message, details);
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Sign in first');
export const forbidden = (message = 'Not allowed') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const conflict = (code, message, details) => new HttpError(409, code, message, details);

export const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify({ ...body, serverTime: Date.now() }),
});

export const csv = (filename, rows) => ({
  statusCode: 200,
  headers: {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  },
  body: rows.map((r) => r.map(csvCell).join(',')).join('\r\n'),
});

function csvCell(value) {
  if (value == null) return '';
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // A leading = + - @ makes spreadsheets run the cell as a formula.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > 1024 * 1024) throw badRequest('body_too_large', 'Request body is over 1 MB');
  try {
    const body = JSON.parse(raw);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw badRequest('bad_json', 'Body must be a JSON object');
  }
}

export function str(value, name, { min = 0, max = 200, optional = false } = {}) {
  if (value == null || value === '') {
    if (optional) return undefined;
    if (min === 0) return '';
    throw badRequest('invalid', `${name} is required`, { field: name });
  }
  if (typeof value !== 'string') throw badRequest('invalid', `${name} must be text`, { field: name });
  const s = value.trim();
  if (s.length < min || s.length > max) {
    throw badRequest('invalid', `${name} must be ${min}-${max} characters`, { field: name });
  }
  return s;
}

export function int(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value == null || value === '') {
    if (optional) return undefined;
    throw badRequest('invalid', `${name} is required`, { field: name });
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw badRequest('invalid', `${name} must be a whole number from ${min} to ${max}`, { field: name });
  }
  return value;
}

export function bool(value, name, { optional = false } = {}) {
  if (value == null) {
    if (optional) return undefined;
    throw badRequest('invalid', `${name} is required`, { field: name });
  }
  if (typeof value !== 'boolean') throw badRequest('invalid', `${name} must be true or false`, { field: name });
  return value;
}

export function oneOf(value, name, options, { optional = false } = {}) {
  if (value == null) {
    if (optional) return undefined;
    throw badRequest('invalid', `${name} is required`, { field: name });
  }
  if (!options.includes(value)) {
    throw badRequest('invalid', `${name} must be one of: ${options.join(', ')}`, { field: name });
  }
  return value;
}
