'use strict';

const { SECRET_PATTERNS, MASK, INLINE_URL_MASK } = require('./defaults.js');

/**
 * Escape a caller-supplied key name so it is matched as LITERAL text.
 *
 * `--redact-keys` takes key names, not a pattern. The names used to be spliced
 * into the regex verbatim, which was wrong twice over:
 *
 *   - `.*` became "match everything", so asking for one extra key silently
 *     masked every value in the file (and, worse, made the caller's real key
 *     list look like it had been honoured when it had not).
 *   - a lone `(` threw a SyntaxError out of the matcher, which nothing caught,
 *     so the process died with a stack trace instead of exit code 2.
 *
 * Escaping means the name can only ever match itself. The built-in
 * SECRET_PATTERNS are ours, not the caller's, and stay unescaped on purpose.
 */
function escapeLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile the active secret patterns into one case-insensitive regex. */
function buildMatcher(extraKeys = []) {
  // The built-in patterns are literal words and need no escaping; the caller's
  // names do, because they are arbitrary text.
  const parts = SECRET_PATTERNS.concat(extraKeys.map((k) => escapeLiteral(k)));
  const unique = [];
  const seen = new Set();
  for (const part of parts) {
    const token = String(part);
    const key = token.toUpperCase();
    if (token !== '' && !seen.has(key)) {
      seen.add(key);
      unique.push(token);
    }
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