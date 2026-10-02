'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { expand, expandObject, parseReference } = require('../src/interpolate.js');
const { InterpolationError } = require('../src/errors.js');

const env = { HOST: 'db.local', PORT: '5432', EMPTY: '' };
const lookup = expandObject(env, {}).object;
const look = (name) => (Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined);

test('${VAR} braced form expands', () => {
  assert.strictEqual(expand('http://${HOST}:${PORT}/x', look), 'http://db.local:5432/x');
});

test('$VAR bare form expands', () => {
  assert.strictEqual(expand('host is $HOST', look), 'host is db.local');
});

test('an unset variable expands to an empty string, not a crash', () => {
  assert.strictEqual(expand('a=${NOPE}b', look), 'a=b');
  assert.strictEqual(expand('a=$NOPE b', look), 'a= b');
});

test('${VAR:-default} uses the default when unset OR empty', () => {
  assert.strictEqual(expand('${EMPTY:-fallback}', look), 'fallback');
  assert.strictEqual(expand('${NOPE:-fallback}', look), 'fallback');
  assert.strictEqual(expand('${PORT:-fallback}', look), '5432');
});

test('${VAR-default} uses the default only when unset', () => {
  assert.strictEqual(expand('${EMPTY-fallback}', look), '');
  assert.strictEqual(expand('${NOPE-fallback}', look), 'fallback');
  assert.strictEqual(expand('${PORT-fallback}', look), '5432');
});

test('${VAR:?message} throws when unset or empty', () => {
  assert.throws(() => expand('${NOPE:?NOPE is required}', look), InterpolationError);
  assert.throws(() => expand('${EMPTY:?EMPTY is required}', look), /EMPTY is required/);
  assert.strictEqual(expand('${PORT:?nope}', look), '5432');
});

test('${VAR?message} throws only when unset, and empty passes', () => {
  assert.throws(() => expand('${NOPE?please set NOPE}', look), /please set NOPE/);
  assert.strictEqual(expand('${EMPTY?please set EMPTY}', look), '');
});

test('a required operator with no message still reports the variable name', () => {
  assert.throws(() => expand('${NOPE:?}', look), /NOPE/);
});

test('a default value may itself contain a reference', () => {
  assert.strictEqual(expand('${MISSING:-$HOST}', look), 'db.local');
});

test('\\$ escapes a literal dollar sign', () => {
  assert.strictEqual(expand('\\$HOST', look), '$HOST');
  assert.strictEqual(expand('\\${HOST}', look), '${HOST}');
});

test('a bare $ not followed by a name stays literal', () => {
  assert.strictEqual(expand('100$ and $ done', look), '100$ and $ done');
});

test('a self-reference resolves to empty instead of looping forever', () => {
  // `A=${A}` reads A's PREVIOUS value. There is none, so it is empty -- the
  // same thing the shell does. The important part is that it terminates.
  const out = expandObject({ A: '${A}' }, { useProcessEnv: false }).object;
  assert.strictEqual(out.A, '');
});

test('a self-reference with a default falls back rather than feeding on itself', () => {
  const out = expandObject({ A: '${A:-safe}' }, { useProcessEnv: false }).object;
  assert.strictEqual(out.A, 'safe');
});

test('an indirect cycle is reported, not looped on', () => {
  const { errors } = expandObject({ A: 'x${B}', B: 'y${A}' }, { useProcessEnv: false });
  assert.ok(errors.length >= 1, 'a cycle must be reported');
  assert.match(errors[0].message, /self-referencing/);
});

test('references may point forward at another key in the same file', () => {
  const out = expandObject({ A: '${B}/x', B: 'later' }, { useProcessEnv: false }).object;
  assert.strictEqual(out.A, 'later/x');
  assert.strictEqual(out.B, 'later');
});

test('expandObject collects per-key errors instead of aborting the batch', () => {
  const { object, errors } = expandObject(
    { OK: 'fine', BAD: '${NOPE:?boom}' },
    { useProcessEnv: false }
  );
  assert.strictEqual(object.OK, 'fine');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].key, 'BAD');
  assert.match(errors[0].message, /boom/);
});

test('expansion can fall back to process.env', () => {
  process.env.ENVJSON_TEST_VALUE = 'from-process';
  try {
    assert.strictEqual(expand('${ENVJSON_TEST_VALUE}', look), '');
    const { object } = expandObject({ X: '${ENVJSON_TEST_VALUE}' }, { useProcessEnv: true });
    assert.strictEqual(object.X, 'from-process');
  } finally {
    delete process.env.ENVJSON_TEST_VALUE;
  }
});

test('parseReference recognizes each supported form', () => {
  assert.deepStrictEqual(parseReference('$A', 0), { name: 'A', operator: null, argument: '', end: 2 });
  assert.strictEqual(parseReference('${A}', 0).name, 'A');
  assert.strictEqual(parseReference('${A:-d}', 0).operator, ':-');
  assert.strictEqual(parseReference('${A-d}', 0).operator, '-');
  assert.strictEqual(parseReference('${A:?m}', 0).operator, ':?');
  assert.strictEqual(parseReference('${A?m}', 0).operator, '?');
});

test('parseReference returns null for a dollar with no valid name', () => {
  assert.strictEqual(parseReference('$1BAD', 0), null);
  assert.strictEqual(parseReference('${unclosed', 0), null);
});

test('nested braces in an argument are matched correctly', () => {
  assert.strictEqual(expand('${NOPE:-a{b}c}', look), 'a{b}c');
});

test('lookup precedence is not used at all here: single quotes keep $ literal', () => {
  const o = require('../src/parser.js').toObject(require('../src/parser.js').parse("A='$HOST'"));
  assert.strictEqual(o.A, '$HOST');
  assert.strictEqual(lookup.HOST, 'db.local');
});