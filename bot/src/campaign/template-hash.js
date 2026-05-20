// Deterministic template hashing for tracking.
// Uses a simple djb2 hash — we don't need cryptographic strength here,
// just a stable key for grouping engagement stats by template.
import { createHash } from 'node:crypto';

/**
 * Hash a template (string or object) to a stable short key.
 * Object templates: hash the text + match tags combined.
 * String templates: hash the raw text.
 */
export function hashTemplate(template) {
  let input;
  if (typeof template === 'string') {
    input = template.trim().toLowerCase();
  } else if (template && typeof template === 'object') {
    const tags = Array.isArray(template.match) ? template.match.sort().join(',') : '';
    input = `${tags}|${(template.text || '').trim().toLowerCase()}`;
  } else {
    return null;
  }
  if (!input) return null;
  return createHash('md5').update(input).digest('hex').slice(0, 12);
}
