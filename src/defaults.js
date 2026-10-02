'use strict';

/**
 * Single source of truth for every option default.
 *
 * Nothing else in the package may hardcode a default. The CLI, the API and the
 * tests all read from this one frozen object so the two layers can never
 * disagree about what "unset" means.
 */
const DEFAULTS = Object.freeze({
  format: 'json',
  files: Object.freeze([]),
  env: Object.freeze([]),
  redact: false,
  redactKeys: Object.freeze([]),
  dryRun: false,
  stats: false,
  explain: false,
  check: false,
  failOnChange: false,
  out: null,
  color: false,
  indent: 2,
});

/** Formats accepted by --format. */
const FORMATS = Object.freeze(['json', 'ndjson', 'jsonl', 'ini', 'properties']);

/** Mask written in place of a redacted value. */
const MASK = '***REDACTED***';

/**
 * Mask written in place of a password inside a connection string. Distinct
 * from MASK so a reader can tell "this whole value was secret" from "this URL
 * had a password in it", which is the difference between a leaked key and a
 * leaked database password.
 */
const INLINE_URL_MASK = '***';

/**
 * Key fragments that make a key look secret. Matched case-insensitively
 * anywhere in the key name.
 */
const SECRET_PATTERNS = Object.freeze([
  'TOKEN',
  'SECRET',
  'KEY',
  'PASSWORD',
  'PASS',
  'CREDENTIAL',
  'AUTH',
  'PRIVATE',
]);

/** Exit codes, documented in the README. */
const EXIT = Object.freeze({
  OK: 0,
  CHANGED: 1,
  USAGE: 2,
  DRIFT: 3,
});

module.exports = { DEFAULTS, FORMATS, MASK, INLINE_URL_MASK, SECRET_PATTERNS, EXIT };