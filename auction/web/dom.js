// Tiny DOM builder shared by the console modules. Children go in as text,
// never as HTML, so server strings can't inject markup.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = !!v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Same merge as the server: objects merge, arrays and scalars replace, null clears. */
export function merge(base, patch) {
  if (patch === undefined) return structuredClone(base);
  if (!isObject(patch) || !isObject(base)) return structuredClone(patch);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(patch)) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : structuredClone(v);
  return out;
}

/** Only the leaves of `cur` that differ from `base`, or undefined when nothing does. */
export function diff(base, cur) {
  if (isObject(base) && isObject(cur)) {
    const out = {};
    for (const k of Object.keys(cur)) {
      const d = diff(base[k], cur[k]);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return JSON.stringify(base) === JSON.stringify(cur) ? undefined : structuredClone(cur);
}
