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

// --- ${VAR:+word} and ${VAR+word} ---------------------------------------
//
// Every expectation below was read off /bin/bash 5.2 and confirmed on
// /bin/dash, which agrees case for case. The `+` family is POSIX parameter
// expansion; before it was implemented the operator did not parse at all, so
// the reference fell through to the plain "yield the variable" branch and
// `${HOST:+localhost}` silently produced HOST's own value.

test('${VAR:+word} yields the word only when the variable is set and non-empty', () => {
  assert.strictEqual(expand('${HOST:+localhost}', look), 'localhost');
  assert.strictEqual(expand('${EMPTY:+fallback}', look), '');
  assert.strictEqual(expand('${NOPE:+fallback}', look), '');
});

test('${VAR+word} yields the word whenever the variable is set, empty included', () => {
  assert.strictEqual(expand('${HOST+localhost}', look), 'localhost');
  assert.strictEqual(expand('${EMPTY+fallback}', look), 'fallback');
  assert.strictEqual(expand('${NOPE+fallback}', look), '');
});

test('an empty word after + means empty, NOT the variable value', () => {
  // This is the asymmetry with ${VAR-}, whose empty word yields the variable.
  // bash: ${A-} and ${A:-} are "alpha"; ${A+} and ${A:+} are both "". Treating
  // an empty + word as "no operator" is what made ${A+} return "alpha".
  assert.strictEqual(expand('${HOST+}', look), '');
  assert.strictEqual(expand('${HOST:+}', look), '');
  assert.strictEqual(expand('${EMPTY+}', look), '');
  assert.strictEqual(expand('${NOPE:+}', look), '');
});

test('the + word is itself a template', () => {
  assert.strictEqual(expand('${HOST:+pre-$PORT-post}', look), 'pre-5432-post');
  assert.strictEqual(expand('${HOST:+${NOPE:-fallback}}', look), 'fallback');
  // `${HOST+:+$PORT}` -- the `:+` inside is literal text of the word, not a
  // nested operator, because the operator is consumed by the FIRST `:?[-?+]`
  // match. bash 5.2 and dash both give ":+5432" here.
  assert.strictEqual(expand('${HOST+:+$PORT}', look), ':+5432');
  assert.strictEqual(expand('${HOST:+:$PORT}', look), ':5432');
});

test('a + word survives surrounding literal text', () => {
  assert.strictEqual(expand('x${HOST:+y}z', look), 'xyz');
  assert.strictEqual(expand('x${EMPTY:+y}z', look), 'xz');
  assert.strictEqual(expand('${HOST:+d}-tail', look), 'd-tail');
});

test('nested + forms resolve innermost first', () => {
  assert.strictEqual(expand('${NOPE:-${HOST:+w}}', look), 'w');
  assert.strictEqual(expand('${HOST:+${HOST:+deep}}', look), 'deep');
  assert.strictEqual(expand('${NOPE:+${NOPE:+deep}}', look), '');
});

test('parseReference recognizes the + forms', () => {
  assert.strictEqual(parseReference('${A:+d}', 0).operator, ':+');
  assert.strictEqual(parseReference('${A+d}', 0).operator, '+');
  // An empty + word keeps its operator; it is NOT demoted to a bare reference.
  assert.strictEqual(parseReference('${A:+}', 0).operator, ':+');
  assert.strictEqual(parseReference('${A+}', 0).operator, '+');
  // The - and ? families still demote, because that is the shell's behaviour.
  assert.strictEqual(parseReference('${A-}', 0).operator, null);
});

test('a key defined by a + template reads its previous value, not itself', () => {
  // Nothing inherited, so the word never applies and the result is empty --
  // the same thing the shell does for `A=${A:+inner}` with no prior A. The
  // important part is that it terminates and does not feed on itself.
  const out = expandObject({ A: '${A:+inner}' }, { useProcessEnv: false }).object;
  assert.strictEqual(out.A, '');
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

// The error list used to be whatever the LAST pass happened to produce, and the
// pass loop stops as soon as a pass changes nothing. A forward reference makes
// pass 1 change something, so pass 2 runs -- and pass 2 fails on exactly the
// same keys pass 1 failed on, for exactly the same reason, because their value
// was rolled back and retried. So the final pass DOES record the error and the
// list comes out empty. Every error was raised, reported, and then dropped on
// the floor one pass later.
//
// It is worse than a lost list. `errors` is the only signal a caller has that a
// `${VAR:?msg}` guard fired, and the guard's entire purpose is to fail the run.
// A caller that checks `errors.length` before deploying config gets `0` and
// ships a config where `DB_PASSWORD` was silently left as the literal string
// `${DB_PASSWORD:?required}`. The CLI is unaffected -- merge() resolves in a
// single pass -- so this reached library callers only.

test('a failing key is still reported after a later pass resolves a forward reference', () => {
  const { object, errors } = expandObject(
    { A: '${B}', B: 'v', BAD: '${NOPE:?boom}' },
    { useProcessEnv: false }
  );
  assert.strictEqual(object.A, 'v', 'the forward reference did resolve');
  assert.strictEqual(errors.length, 1, 'and the failure did not get lost');
  assert.strictEqual(errors[0].key, 'BAD');
  assert.match(errors[0].message, /boom/);
});

test('every failing key survives the extra passes, in file order', () => {
  const { errors } = expandObject(
    { BAD1: '${N1:?b1}', BAD2: '${N2:?b2}', X: '${LATER}', LATER: 'v' },
    { useProcessEnv: false }
  );
  assert.deepStrictEqual(
    errors.map((e) => e.key),
    ['BAD1', 'BAD2']
  );
});

// A key that stops failing -- its dependency arrives in a later pass -- must
// stop being reported, or a legitimate forward reference would be held
// against the caller forever.
test('a key that resolves once its dependency arrives is not reported', () => {
  const { object, errors } = expandObject(
    { A: '${B}', B: '${C}', C: 'finally' },
    { useProcessEnv: false }
  );
  assert.strictEqual(object.A, 'finally');
  assert.deepStrictEqual(errors, []);
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