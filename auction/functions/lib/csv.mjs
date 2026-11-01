// Minimal RFC 4180 CSV reader: quoted fields, doubled quotes, CRLF or LF.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** Rows as objects keyed by the (trimmed, lower-cased) header row. */
export function csvObjects(text) {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  if (!header) return [];
  const names = header.map((h) => h.trim().toLowerCase());
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, (r[i] ?? '').trim()])));
}
