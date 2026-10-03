'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { redactObject, isSecretKey, buildMatcher, MASK } = require('../src/redact.js');
const { SECRET_PATTERNS } = require('../src/defaults.js');

test('the documented secret patterns are all present', () => {
  for (const p of ['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'PASS', 'CREDENTIAL', 'AUTH', 'PRIVATE']) {
    assert.ok(SECRET_PATTERNS.includes(p), `missing ${p}`);
  }
});

test('secret-looking keys are masked and ordinary keys stay readable', () => {
  const r = redactObject({
    API_TOKEN: 'abc123',
    DB_PASSWORD: 'hunter2',
    PORT: '8080',
    LOG_LEVEL: 'debug',
  });
  assert.strictEqual(r.object.API_TOKEN, MASK);
  assert.strictEqual(r.object.DB_PASSWORD, MASK);
  assert.strictEqual(r.object.PORT, '8080');
  assert.strictEqual(r.object.LOG_LEVEL, 'debug');
});

test('every documented pattern actually matches a plausible key', () => {
  const samples = {
    GITHUB_TOKEN: 'x',
    CLIENT_SECRET: 'x',
    STRIPE_KEY: 'x',
    MY_PASSWORD: 'x',
    PASS: 'x',
    AWS_CREDENTIALS: 'x',
    AUTH_HEADER: 'x',
    PRIVATE_KEY: 'x',
  };
  for (const key of Object.keys(samples)) {
    assert.ok(isSecretKey(key), `${key} should match`);
  }
});

test('key matching is case insensitive', () => {
  assert.ok(isSecretKey('api_token'));
  assert.ok(isSecretKey('Api_Token'));
  assert.strictEqual(isSecretKey('PORT'), false);
  assert.strictEqual(isSecretKey('HOSTNAME'), false);
  assert.strictEqual(isSecretKey('TIMEOUT'), false);
});

test('--redact-keys adds extra key names', () => {
  const r = redactObject({ SESSION: 'abc', PORT: '1' }, { keys: ['session'] });
  assert.strictEqual(r.object.SESSION, MASK);
  assert.strictEqual(r.object.PORT, '1');
});

test('--redact-keys accepts comma separated names and trims spaces', () => {
  const m = buildMatcher([' A ', 'B', 'A']);
  assert.ok(m.pattern.test('A'));
  assert.ok(m.pattern.test('B'));
  assert.ok(m.pattern.test('a'));
});

// The caller's key names are literal text to be matched against a key, not
// a regex the caller is asking us to compile. Anything they type has to be
// matched literally, and nothing they type may blow up the matcher.
//
// Every name below is built out of letters that appear in NO built-in pattern
// (TOKEN/SECRET/KEY/PASSWORD/PASS/CREDENTIAL/AUTH/PRIVATE), so a positive match
// can only come from the name under test. Without that care the assertion
// passes for the wrong reason -- "API_KEY" matches because of the built-in KEY,
// not because the `|` was escaped.
test('a user key name is matched literally, not as a regex', () => {
  // `.` must not turn into "any character".
  const m = buildMatcher(['AB.CD']);
  assert.ok(m.pattern.test('AB.CD'));
  assert.strictEqual(m.pattern.test('ABXCD'), false, 'the dot must stay literal');

  // `|` must not introduce an alternative.
  const m2 = buildMatcher(['SESSION|ANTHROPIC']);
  assert.ok(m2.pattern.test('SESSION|ANTHROPIC'));
  assert.strictEqual(m2.pattern.test('SESSION'), false);
  assert.strictEqual(m2.pattern.test('ANTHROPIC'), false);

  // `*` is a quantifier only when unescaped.
  const m3 = buildMatcher(['KK*']);
  assert.ok(m3.pattern.test('KK*'));
  assert.strictEqual(m3.pattern.test('KKKKK'), false);

  // `+` and `?` likewise.
  const m4 = buildMatcher(['MM+']);
  assert.strictEqual(m4.pattern.test('MMMM'), false);
  const m5 = buildMatcher(['NN?']);
  assert.strictEqual(m5.pattern.test('NNN'), false);
});

test('a regex metacharacter in a key name does not throw', () => {
  for (const key of ['(', ')', '[', '*', '+', '?', '{2}', '\\', '[a-z]', '(?:x)', '$1']) {
    assert.doesNotThrow(
      () => buildMatcher([key]),
      `--redact-keys ${JSON.stringify(key)} must not throw`
    );
  }
});

test('a regex metacharacter key name cannot unmask the built-in patterns', () => {
  // `.*` used to be spliced in verbatim, making every key match.
  const m = buildMatcher(['.*']);
  assert.strictEqual(m.pattern.test('PORT'), false, 'PORT must not match just because of .*');
  assert.strictEqual(m.pattern.test('LOG_LEVEL'), false);
  assert.ok(m.pattern.test('.*'), 'the literal name still matches itself');
});

test('a key name with regex syntax does not leak the built-in patterns away', () => {
  const m = buildMatcher(['A|B', '.*']);
  assert.ok(m.pattern.test('A_TOKEN'), 'built-in patterns still work alongside odd names');
});

// `patterns` is the human-facing record of what the matcher will look for, so
// it must report the name the caller actually wrote. The matcher used to
// upper-case everything on the way in, which made a redaction report read
// "SESSION" when the operator had typed "session". Matching is case-insensitive
// either way, so this is about the report being honest, not about behaviour.
test('patterns preserves the caller\'s own casing but still dedupes case-insensitively', () => {
  const m = buildMatcher(['session', 'SESSION', 'Session', 'Api-Token']);
  const extra = m.patterns.slice(SECRET_PATTERNS.length);
  assert.deepStrictEqual(extra, ['session', 'Api-Token']);
  assert.ok(m.pattern.test('SESSION'), 'still matches case-insensitively');
  assert.ok(m.pattern.test('api-token'));
  assert.strictEqual(m.patterns.filter((p) => p === 'TOKEN').length, 1, 'no duplicates');
});

// The reason the escaping matters in practice: ini and properties files turn
// `[db]` + `URI` into the key `db.URI`, so dotted names are ordinary, not exotic.
test('a dotted key name masks only that key, not its neighbours', () => {
  const r = redactObject({ 'db.URI': 'a', 'db.URL': 'b' }, { keys: ['db.URI'] });
  assert.strictEqual(r.object['db.URI'], MASK);
  assert.strictEqual(r.object['db.URL'], 'b', 'the dot is literal, so db.URL survives');
});

test('an empty secret value stays empty rather than becoming a mask', () => {
  const r = redactObject({ TOKEN: '' });
  assert.strictEqual(r.object.TOKEN, '');
});

test('the list of redacted keys is reported', () => {
  const r = redactObject({ A_TOKEN: 'x', B: 'y', C_KEY: 'z' });
  assert.deepStrictEqual(r.redactedKeys, ['A_TOKEN', 'C_KEY']);
});

test('a custom mask can be supplied', () => {
  const r = redactObject({ TOKEN: 'x' }, { mask: '##' });
  assert.strictEqual(r.object.TOKEN, '##');
});

test('redaction does not mutate the input object', () => {
  const input = { TOKEN: 'keepme' };
  redactObject(input);
  assert.strictEqual(input.TOKEN, 'keepme');
});

test('a redacted value is indistinguishable in shape from a short secret', () => {
  const r = redactObject({ KEY: 'x' });
  assert.strictEqual(typeof r.object.KEY, 'string');
  assert.ok(r.object.KEY.length > 0);
});