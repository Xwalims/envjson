'use strict';

const { SECRET_PATTERNS, MASK } = require('./defaults.js');

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
 * Mask secret-looking values, leaving everything else readable.
 *
 * Empty values stay empty (masking "" would invent a secret that is not there).
 */
function redactObject(object, options = {}) {
  const matcher = buildMatcher(options.keys || []);
  const mask = options.mask || MASK;
  const out = {};
  const redactedKeys = [];
  for (const [key, value] of Object.entries(object)) {
    if (isSecretKey(key, matcher)) {
      redactedKeys.push(key);
      out[key] = value === '' ? '' : mask;
    } else {
      out[key] = value;
    }
  }
  return { object: out, redactedKeys };
}

module.exports = { redactObject, isSecretKey, buildMatcher, MASK };