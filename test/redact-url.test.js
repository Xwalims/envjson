'use strict';

/**
 * Inline credentials in connection strings.
 *
 * These cases exist because masking by KEY NAME is not enough: a password in
 * `DATABASE_URL` or `BACKEND_DSN` hides behind an innocuous name, while masking
 * the whole value of a secret-looking key throws away a URL that was useful to
 * read. Masking the userinfo section by shape handles both.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { redactObject, maskUrlUserinfo } = require('../src/redact.js');
const { INLINE_URL_MASK } = require('../src/defaults.js');

test('a password in a postgres URL is masked, the rest stays readable', () => {
  const { object } = redactObject({ DATABASE_URL: 'postgres://user:s3cret@db:5432/app' });
  assert.equal(object.DATABASE_URL, `postgres://user:${INLINE_URL_MASK}@db:5432/app`);
});

test('a password in a mysql URL is masked', () => {
  const { object } = redactObject({ MYSQL: 'mysql://root:pa55@localhost/db' });
  assert.equal(object.MYSQL, `mysql://root:${INLINE_URL_MASK}@localhost/db`);
});

test('a Redis URL with an empty username is still masked', () => {
  // The single most common real shape, and one a `user:pass` regex misses.
  const { object } = redactObject({ REDIS_URL: 'redis://:hunter2@cache:6379/0' });
  assert.equal(object.REDIS_URL, `redis://:${INLINE_URL_MASK}@cache:6379/0`);
});

test('an amqp URL with the default guest credentials is masked', () => {
  const { object } = redactObject({ AMQP: 'amqp://guest:guest@rabbit:5672/' });
  assert.equal(object.AMQP, `amqp://guest:${INLINE_URL_MASK}@rabbit:5672/`);
});

test('a URL with a username but no password is left alone', () => {
  const { object, urlMasks } = redactObject({ SITE: 'mysql://root@localhost/db' });
  assert.equal(object.SITE, 'mysql://root@localhost/db');
  assert.deepEqual(urlMasks, []);
});

test('a plain URL with no userinfo is left alone', () => {
  const { object } = redactObject({ API: 'http://host:8080/path' });
  assert.equal(object.API, 'http://host:8080/path');
});

test('text that merely contains @ is not treated as a URL', () => {
  const { object } = redactObject({ NOTE: 'not-a-url:pw@x' });
  assert.equal(object.NOTE, 'not-a-url:pw@x');
});

test('an empty password is left as written rather than gaining a mask', () => {
  // Masking an empty secret would invent one that is not there.
  const { object, urlMasks } = redactObject({ U: 'scheme://user:@host' });
  assert.equal(object.U, 'scheme://user:@host');
  assert.deepEqual(urlMasks, []);
});

test('an empty value stays empty', () => {
  const { object } = redactObject({ G: '' });
  assert.equal(object.G, '');
});

test('a secret-looking key is masked wholesale, not just its userinfo', () => {
  const { object, redactedKeys } = redactObject({
    API_TOKEN: 'postgres://user:s3cret@db/app',
  });
  assert.equal(object.API_TOKEN, '***REDACTED***');
  assert.deepEqual(redactedKeys, ['API_TOKEN']);
});

test('urlMasks lists only the keys whose URL changed', () => {
  const { urlMasks } = redactObject({
    A: 'postgres://u:p@h/db',
    B: 'plain',
    C: 'redis://:p@h',
  });
  assert.deepEqual(urlMasks.sort(), ['A', 'C']);
});

test('every password in one value is masked', () => {
  const { object } = redactObject({ M: 'postgres://a:pa@h/db,redis://b:pb@h' });
  assert.equal(object.M, `postgres://a:${INLINE_URL_MASK}@h/db,redis://b:${INLINE_URL_MASK}@h`);
});

test('maskUrlUserinfo is usable on its own', () => {
  assert.deepEqual(maskUrlUserinfo('x'), { value: 'x', changed: false });
  assert.deepEqual(maskUrlUserinfo('ftp://u:p@h'), {
    value: `ftp://u:${INLINE_URL_MASK}@h`,
    changed: true,
  });
});

test('maskUrlUserinfo rejects non-strings without throwing', () => {
  assert.deepEqual(maskUrlUserinfo(undefined), { value: undefined, changed: false });
  assert.deepEqual(maskUrlUserinfo(42), { value: 42, changed: false });
});

test('a custom urlMask is honoured', () => {
  const { object } = redactObject(
    { A: 'postgres://u:pw@h' },
    { urlMask: '<hidden>' },
  );
  assert.equal(object.A, 'postgres://u:<hidden>@h');
});

test('the original secret never survives in the output', () => {
  const secret = 'sup3rS3cretValue';
  const { object } = redactObject({ BACKEND_DSN: `postgres://appuser:${secret}@host/db` });
  assert.ok(!JSON.stringify(object).includes(secret));
});