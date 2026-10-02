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

module.exports = { DEFAULTS, FORMATS, MASK, SECRET_PATTERNS, EXIT };