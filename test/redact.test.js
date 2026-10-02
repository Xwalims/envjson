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