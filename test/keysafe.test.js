'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { assignKey, hasKey, copyOwn, PROTO } = require('../src/keysafe.js');
const { parse, toObject } = require('../src/parser.js');
const { merge, mergeSources, mergeValues } = require('../src/merge.js');
const { expandObject } = require('../src/interpolate.js');
const { redactObject } = require('../src/redact.js');
const { format } = require('../src/cli.js');

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'envjson.js');

/** Run the real bin on a throwaway .env and return its parsed stdout. */
function runBin(text, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envjson-proto-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, text);
  try {
    const r = spawnSync(process.execPath, [BIN, file, ...args], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `bin failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `__proto__` is the one legal key name that plain assignment cannot store:
 * it is an inherited accessor, so `obj.__proto__ = v` runs the setter (which
 * swaps the object's prototype) instead of creating a key. The file said the
 * variable exists; the output must therefore contain it, and it must be DATA,
 * exactly as `JSON.parse('{"__proto__":"v"}')` produces.
 *
 * Every assertion below checks the descriptor too, not just `Object.keys`:
 * a key that only exists on the prototype chain would pass a naive
 * `obj.__proto__` check while being invisible to JSON.stringify and to
 * Object.entries.
 */

/** Assert `key` is an own, enumerable, writable DATA property equal to `value`. */
function assertOwnData(obj, key, value) {
  assert.ok(hasKey(obj, key), `${key} must be an OWN property`);
  const d = Object.getOwnPropertyDescriptor(obj, key);
  assert.strictEqual(d.enumerable, true, `${key} must be enumerable`);
  assert.strictEqual(d.writable, true, `${key} must be writable`);
  assert.strictEqual(d.configurable, true, `${key} must be configurable`);
  assert.ok(
    !('get' in d) && !('set' in d),
    `${key} must be a data property, not an accessor`
  );
  assert.strictEqual(obj[key], value, `${key} value`);
  assert.deepStrictEqual(Object.keys(obj), Object.keys(JSON.parse(JSON.stringify(obj))));
}

/** JSON.stringify with __proto__ made enumerable by JSON.parse semantics. */
function canonical(obj) {
  return JSON.stringify(JSON.parse(JSON.stringify(obj)));
}

test('assignKey stores __proto__ as data where plain assignment cannot', () => {
  const plain = {};
  plain.__proto__ = 'lost';
  // This is the bug in miniature: the setter ran and no key exists.
  assert.strictEqual(Object.keys(plain).length, 0);

  const safe = assignKey({}, PROTO, 'kept');
  assertOwnData(safe, PROTO, 'kept');
  assert.strictEqual(JSON.stringify(safe), '{"__proto__":"kept"}');
  assert.strictEqual(Object.getPrototypeOf(safe), Object.prototype, 'prototype untouched');
});

test('assignKey matches JSON.parse for a whole map, not just one key', () => {
  const src = JSON.parse('{"__proto__":"p","constructor":"c","toString":"t","A":"1"}');
  const built = {};
  for (const [k, v] of Object.entries(src)) assignKey(built, k, v);
  assert.strictEqual(canonical(built), canonical(src));
  assert.deepStrictEqual(Object.keys(built), Object.keys(src));
});

test('copyOwn keeps __proto__; Object.assign silently drops it', () => {
  const src = assignKey({ A: '1' }, PROTO, 'p');
  assert.strictEqual(Object.keys(Object.assign({}, src)).length, 1, 'oracle: assign drops it');
  const copied = copyOwn(src);
  assertOwnData(copied, PROTO, 'p');
  assert.strictEqual(copied.A, '1');
});

test('parse keeps a __proto__ line in the entry list', () => {
  const result = parse('__proto__=polluted\nA=1\n');
  assert.deepStrictEqual(
    result.entries.map((e) => e.key),
    [PROTO, 'A']
  );
  assert.strictEqual(result.entries[0].value, 'polluted');
  assert.strictEqual(result.entries[0].line, 1);
});

test('toObject round-trips __proto__ byte-identically to JSON.parse', () => {
  const o = toObject(parse('__proto__=polluted\nA=1\n'));
  assertOwnData(o, PROTO, 'polluted');
  assert.strictEqual(o.A, '1');
  const fromJson = JSON.parse('{"__proto__":"polluted","A":"1"}');
  assert.strictEqual(canonical(o), canonical(fromJson));
  assert.deepStrictEqual(
    Object.getOwnPropertyDescriptor(o, PROTO).value,
    Object.getOwnPropertyDescriptor(fromJson, PROTO).value
  );
});

test('a __proto__ line neither pollutes nor re-prototypes any internal object', () => {
  const o = toObject(parse('__proto__=polluted\n'));
  assert.strictEqual(Object.getPrototypeOf(o), Object.prototype);
  // The value must NOT be reachable by walking the prototype chain, which is
  // what the old behaviour looked like from a caller's side.
  assert.notStrictEqual(Object.getPrototypeOf({}).polluted, 'polluted');
  assert.strictEqual({}.polluted, undefined);
});

test('a later layer overrides an inherited __proto__ like any other key', () => {
  const r = mergeSources(
    [{ name: 'a', text: '__proto__=one\nA=1\n' }, { name: 'b', text: '__proto__=two\n' }],
    { useProcessEnv: false }
  );
  assertOwnData(r.object, PROTO, 'two');
  assert.strictEqual(r.overridden.length, 1);
  assert.strictEqual(r.overridden[0].key, PROTO);
  assert.strictEqual(r.provenance[PROTO].file, 'b');
  assert.deepStrictEqual(
    r.changes.filter((c) => c.key === PROTO).map((c) => c.kind),
    ['add', 'override']
  );
});

test('merge inherits a __proto__ self-reference instead of clobbering it', () => {
  const r = mergeSources(
    [
      { name: 'base', text: '__proto__=inherited\n' },
      { name: 'over', text: '__proto__=${__proto__}\n' },
    ],
    { useProcessEnv: false }
  );
  assertOwnData(r.object, PROTO, 'inherited');
  assert.strictEqual(r.overridden.length, 0);
});

test('an unresolvable __proto__ template resolves to empty, per the self-ref rule', () => {
  // Documented behaviour: `A=${A}` with nothing inherited yields the empty
  // string, not an error. `__proto__` follows the same path as any other key.
  const r = mergeSources([{ name: 'a', text: '__proto__=${__proto__}\n' }], {
    useProcessEnv: false,
  });
  assert.strictEqual(r.errors.length, 0);
  assertOwnData(r.object, PROTO, '');
});

test('a failing __proto__ template is dropped and reported like any other key', () => {
  const r = mergeSources([{ name: 'a', text: '__proto__=${__proto__:?required}\nA=1\n' }], {
    useProcessEnv: false,
  });
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].key, PROTO);
  assert.match(r.errors[0].message, /required/);
  assert.ok(!hasKey(r.object, PROTO), 'a failed key must not be invented back');
  assert.strictEqual(r.object.A, '1', 'siblings are unaffected');
});

test('mergeValues keeps a __proto__ entry from --env', () => {
  const r = mergeValues([[[PROTO, 'v'], ['A', '1']]], { useProcessEnv: false });
  assertOwnData(r.object, PROTO, 'v');
});

test('mergeValues treats a repeated __proto__ as an override', () => {
  const r = mergeValues([[[PROTO, 'one']], [[PROTO, 'two']]], { useProcessEnv: false });
  assertOwnData(r.object, PROTO, 'two');
  assert.strictEqual(r.overridden.length, 1);
});

test('expandObject keeps __proto__ through every resolution pass', () => {
  const o = assignKey({ B: '${__proto__}-suffix' }, PROTO, 'root');
  const r = expandObject(o, { useProcessEnv: false });
  assertOwnData(r.object, PROTO, 'root');
  assert.strictEqual(r.object.B, 'root-suffix');
  assert.strictEqual(r.errors.length, 0);
});

test('redactObject masks a __proto__ key only when asked to', () => {
  // By key NAME `__proto__` is not secret, and the point of this tool is that
  // redaction is name-driven: an innocuous name must not get masked silently.
  const passthrough = redactObject(assignKey({}, PROTO, 'secret'), {});
  assertOwnData(passthrough.object, PROTO, 'secret');
  assert.deepStrictEqual(passthrough.redactedKeys, []);

  const r = redactObject(assignKey({}, PROTO, 'secret'), { keys: [PROTO] });
  assertOwnData(r.object, PROTO, '***REDACTED***');
  assert.deepStrictEqual(r.redactedKeys, [PROTO]);
});

test('a wildcard-looking --redact-keys entry still cannot reach __proto__', () => {
  // `--redact-keys` takes names, not patterns (redact.js escapes them), so a
  // caller passing `*PROTO*` must not accidentally match the real key.
  const r = redactObject(assignKey({}, PROTO, 's'), { keys: ['*PROTO*'] });
  assertOwnData(r.object, PROTO, 's');
  assert.deepStrictEqual(r.redactedKeys, []);
});

test('redactObject leaves an empty __proto__ empty', () => {
  const r = redactObject(assignKey({}, PROTO, ''), { keys: [PROTO] });
  assertOwnData(r.object, PROTO, '');
});

test('every output format serializes __proto__ instead of dropping it', () => {
  const o = assignKey({ A: '1' }, PROTO, 'polluted');
  assert.strictEqual(format(o, 'json'), '{\n  "A": "1",\n  "__proto__": "polluted"\n}\n');
  assert.strictEqual(format(o, 'ndjson'), '"A": "1"\n"__proto__": "polluted"\n');
  assert.strictEqual(format(o, 'properties'), 'A=1\n__proto__=polluted\n');
  assert.strictEqual(format(o, 'ini'), 'A = 1\n__proto__ = polluted\n');
});

test('output order is insertion order, and __proto__ never sorts to the front', () => {
  // Nothing re-sorts the map on the way out, so `__proto__` lands where the
  // file put it. A test that compared sorted keys would have missed this.
  const o = toObject(parse('__proto__=polluted\nA=1\n'));
  assert.deepStrictEqual(Object.keys(o), [PROTO, 'A']);
  assert.strictEqual(format(o, 'json'), '{\n  "__proto__": "polluted",\n  "A": "1"\n}\n');
});

test('a section-qualified __proto__ key survives ini parsing', () => {
  const o = toObject(parse('[app]\n__proto__=x\n', { format: 'ini' }));
  assertOwnData(o, 'app.__proto__', 'x');
  assert.strictEqual(JSON.parse(JSON.stringify(o))['app.__proto__'], 'x');
});

test('sameShape comparison does not lose __proto__ to a prototype walk', () => {
  // Guards the --check path: an extra __proto__ key must read as drift.
  const a = assignKey({}, PROTO, 'x');
  const b = { A: '1' };
  const ka = Object.keys(a);
  assert.ok(ka.includes(PROTO));
  assert.ok(!Object.keys(b).includes(PROTO));
});

test('the real bin emits __proto__ in its JSON stdout', () => {
  const out = runBin('__proto__=polluted\nA=1\n');
  assert.deepStrictEqual(Object.keys(out), [PROTO, 'A']);
  assert.strictEqual(out[PROTO], 'polluted');
});

test('the real bin emits __proto__ in --format properties', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envjson-proto-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '__proto__=polluted\nA=1\n');
  try {
    const r = spawnSync(process.execPath, [BIN, file, '--format', 'properties'], {
      encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '__proto__=polluted\nA=1\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});