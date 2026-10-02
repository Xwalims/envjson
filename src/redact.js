'use strict';

const { SECRET_PATTERNS, MASK, INLINE_URL_MASK } = require('./defaults.js');

/** Compile the active secret patterns into one case-insensitive regex. */
function buildMatcher(extraKeys = []) {
  const parts = SECRET_PATTERNS.concat(
    extraKeys.map((k) => String(k).toUpperCase())
  );
  const unique = [];
  for (const part of parts) {
    const token = String(part).toUpperCase();
    if (token !== '' && !unique.includes(token)) unique.push(token);
  }
  return { pattern: new RegExp(unique.join('|'), 'i'), patterns: unique };
}

/** True when `key` should be masked. */
function isSecretKey(key, matcher) {
  const m = matcher || buildMatcher();
  return m.pattern.test(String(key));
}

/**
 * Inline credentials inside a connection string.
 *
 * `DATABASE_URL=postgres://user:s3cret@host/db` is one of the most common
 * places a real credential lives in a .env file, and the key name alone is a
 * poor signal: `DATABASE_URL`, `REDIS_DSN`, `BACKEND` all hide a password
 * behind an innocuous name, while `API_TOKEN` hides one behind an obvious one.
 * Masking by key name therefore both misses the former and, when it fires,
 * throws away a whole readable URL.
 *
 * So the userinfo section is masked by SHAPE: the password between the colon
 * and the `@`. The scheme, username, host, port and path stay readable, which
 * is what makes a redacted config file still useful.
 *
 * Deliberately not matched: `scheme://user@host` (username only, no secret)
 * and a bare `host:port` authority.
 *
 * The username is optional, which matters more than it looks:
 * `redis://:pw@host` and `amqp://guest:guest@host` both appear in real configs,
 * and a regex that requires `user:pass` silently leaves the Redis form alone.
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s]*):([^/@\s]*)@/gi;

/**
 * Mask secret-looking values, leaving everything else readable.
 *
 * Empty values stay empty (masking "" would invent a secret that is not there).
 *
 * @param {Record<string, string>} object
 * @param {{keys?: string[], mask?: string}} [options]
 * @returns {{object: Record<string, string>, redactedKeys: string[], urlMasks: string[]}}
 */
function redactObject(object, options = {}) {
  const matcher = buildMatcher(options.keys || []);
  const mask = options.mask || MASK;
  const inlineMask = options.urlMask || INLINE_URL_MASK;
  const out = {};
  const redactedKeys = [];
  const urlMasks = [];
  for (const [key, value] of Object.entries(object)) {
    if (isSecretKey(key, matcher)) {
      redactedKeys.push(key);
      out[key] = value === '' ? '' : mask;
      continue;
    }
    const masked = maskUrlUserinfo(value, inlineMask);
    if (masked.changed) urlMasks.push(key);
    out[key] = masked.value;
  }
  return { object: out, redactedKeys, urlMasks };
}

/**
 * Replace the password in every connection string inside `value`.
 *
 * @param {string} value
 * @param {string} mask
 * @returns {{value: string, changed: boolean}}
 */
function maskUrlUserinfo(value, mask = INLINE_URL_MASK) {
  if (typeof value !== 'string' || !value.includes('@') || !value.includes('://')) {
    return { value, changed: false };
  }
  let changed = false;
  const next = value.replace(URL_USERINFO, (match, scheme, user, password) => {
    if (password === '') return match;
    changed = true;
    return `${scheme}${user}:${mask}@`;
  });
  return { value: next, changed };
}

module.exports = {
  redactObject,
  isSecretKey,
  buildMatcher,
  maskUrlUserinfo,
  URL_USERINFO,
  INLINE_URL_MASK,
  MASK,
};