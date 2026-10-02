'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { merge, mergeSources, mergeValues } = require('../src/merge.js');

const layer = (name, text, format) => ({ name, text, format });

/** The LAST recorded change for a key, i.e. what the newest layer did to it. */
function lastChange(result, key) {
  const hits = result.changes.filter((c) => c.key === key);
  return hits[hits.length - 1];
}

test('a later layer overrides an earlier one', () => {
  const r = mergeSources([layer('base.env', 'A=1\nB=1\n'), layer('prod.env', 'A=2\n')], {
    useProcessEnv: false,
  });
  assert.strictEqual(r.object.A, '2');
  assert.strictEqual(r.object.B, '1');
  assert.strictEqual(r.overridden.length, 1);
  assert.strictEqual(r.overridden[0].key, 'A');
});

test('provenance records the file and line of the winning value', () => {
  const r = mergeSources([layer('base.env', 'A=1\n'), layer('prod.env', '\n\nA=2\n')], {
    useProcessEnv: false,
  });
  assert.strictEqual(r.provenance.A.file, 'prod.env');
  assert.strictEqual(r.provenance.A.line, 3);
});

test('keys only present in a later layer are added, not overridden', () => {
  const r = mergeSources([layer('a.env', 'A=1\n'), layer('b.env', 'B=2\n')], {
    useProcessEnv: false,
  });
  assert.deepStrictEqual(r.object, { A: '1', B: '2' });
  assert.strictEqual(r.overridden.length, 0);
});

test('a pure ${VAR} layer value does NOT clobber the inherited value', () => {
  const r = mergeSources(
    [layer('base.env', 'PORT=8080\nHOST=a\n'), layer('override.env', 'PORT=${PORT}\n')],
    { useProcessEnv: false }
  );
  assert.strictEqual(r.object.PORT, '8080');
  assert.strictEqual(r.overridden.length, 0);
  assert.strictEqual(lastChange(r, 'PORT').kind, 'kept');
});

test('a pure ${VAR} that does not resolve leaves the inherited value alone', () => {
  const r = mergeSources(
    [layer('base.env', 'PORT=8080\n'), layer('o.env', 'PORT=${UNSET_ANYWHERE}\n')],
    { useProcessEnv: false }
  );
  assert.strictEqual(r.object.PORT, '8080');
  assert.strictEqual(lastChange(r, 'PORT').kind, 'kept');
});

test('a pure ${VAR} in the FIRST layer resolves normally (nothing to keep)', () => {
  const r = mergeSources([layer('a.env', 'PORT=${PORT:-3000}\n')], { useProcessEnv: false });
  assert.strictEqual(r.object.PORT, '3000');
});

test('a pure ${VAR} with no inherited value resolves to empty, not a crash', () => {
  const r = mergeSources([layer('a.env', 'PORT=${PORT}\n')], { useProcessEnv: false });
  assert.strictEqual(r.object.PORT, '');
});

test('a default form is a real override and reads the inherited value', () => {
  const r = mergeSources(
    [layer('a.env', 'PORT=8080\n'), layer('b.env', 'PORT=${PORT:-3000}\n')],
    { useProcessEnv: false }
  );
  assert.strictEqual(r.object.PORT, '8080');
  assert.strictEqual(r.overridden.length, 1, 'recorded as an override');
});

test('a default form with no inherited value falls back to the default', () => {
  const r = mergeSources([layer('a.env', 'PORT=${PORT:-3000}\n')], { useProcessEnv: false });
  assert.strictEqual(r.object.PORT, '3000');
});

test('a single-quoted ${VAR} is literal, so it IS an override', () => {
  const r = mergeSources(
    [layer('a.env', 'PORT=8080\n'), layer('b.env', "PORT='${PORT}'\n")],
    { useProcessEnv: false }
  );
  assert.strictEqual(r.object.PORT, '${PORT}');
  assert.strictEqual(r.overridden.length, 1);
});

test('overrides are recorded in order with from/to values', () => {
  const r = mergeSources(
    [layer('a.env', 'A=1\n'), layer('b.env', 'A=2\n'), layer('c.env', 'A=3\n')],
    { useProcessEnv: false }
  );
  assert.strictEqual(r.overridden.length, 2);
  assert.strictEqual(r.overridden[1].fromValue, '2');
  assert.strictEqual(r.overridden[1].toValue, '3');
  assert.strictEqual(r.object.A, '3');
});

test('values are interpolated after merging, so layers see each other', () => {
  const r = mergeSources(
    [layer('a.env', 'BASE=/srv/app\n'), layer('b.env', 'FULL=${BASE}/public\n')],
    { useProcessEnv: false }
  );
  assert.strictEqual(r.object.FULL, '/srv/app/public');
});

test('a forward reference resolves even though the target comes later', () => {
  const r = mergeSources([layer('a.env', 'A=${B}/x\nB=later\n')], { useProcessEnv: false });
  assert.strictEqual(r.object.A, 'later/x');
});

test('a chained reference resolves across three keys', () => {
  const r = mergeSources([layer('a.env', 'A=${B}\nB=${C}\nC=final\n')], {
    useProcessEnv: false,
  });
  assert.strictEqual(r.object.A, 'final');
  assert.strictEqual(r.object.B, 'final');
});

test('merge handles plain value layers (--env) with highest precedence', () => {
  const r = mergeValues([{ A: '1' }, { A: '2', B: '2' }], { useProcessEnv: false });
  assert.strictEqual(r.object.A, '2');
  assert.strictEqual(r.overridden.length, 1);
});

test('duplicates inside a layer are reported with the file name attached', () => {
  const r = mergeSources([layer('a.env', 'A=1\nA=2\n')], { useProcessEnv: false });
  assert.strictEqual(r.duplicates.length, 1);
  assert.strictEqual(r.duplicates[0].file, 'a.env');
  assert.strictEqual(r.object.A, '2');
});

test('merge of a single empty layer yields an empty object', () => {
  const r = mergeSources([layer('a.env', '')], { useProcessEnv: false });
  assert.deepStrictEqual(r.object, {});
});

test('an interpolation error is surfaced per key rather than thrown', () => {
  const r = mergeSources([layer('a.env', 'X=${NOPE:?must set NOPE}\n')], {
    useProcessEnv: false,
  });
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].key, 'X');
});

test('a failed key is dropped from the output but its siblings survive', () => {
  const r = mergeSources([layer('a.env', 'OK=fine\nX=${NOPE:?boom}\n')], {
    useProcessEnv: false,
  });
  assert.strictEqual(r.object.OK, 'fine');
  assert.ok(!('X' in r.object), 'X must not appear in the output');
  assert.strictEqual(r.errors.length, 1);
});

test('a single-quoted value survives merging untouched', () => {
  const r = mergeSources([layer('a.env', "RAW='\\n${X}'\n")], { useProcessEnv: false });
  assert.strictEqual(r.object.RAW, '\\n${X}');
});

test('a double-quoted escape is unescaped exactly once, not twice', () => {
  const r = mergeSources([layer('a.env', 'A="C:\\\\dir"\n')], { useProcessEnv: false });
  assert.strictEqual(r.object.A, 'C:\\dir');
});

test('an empty layer in the middle changes nothing', () => {
  const r = mergeSources(
    [layer('a.env', 'A=1\n'), layer('empty.env', ''), layer('c.env', 'B=2\n')],
    { useProcessEnv: false }
  );
  assert.deepStrictEqual(r.object, { A: '1', B: '2' });
});

test('multi-file order is significant: reversing the layers reverses the winner', () => {
  const forward = mergeSources([layer('a', 'A=1\n'), layer('b', 'A=2\n')], {
    useProcessEnv: false,
  });
  const backward = mergeSources([layer('b', 'A=2\n'), layer('a', 'A=1\n')], {
    useProcessEnv: false,
  });
  assert.strictEqual(forward.object.A, '2');
  assert.strictEqual(backward.object.A, '1');
});

test('a self-reference cycle across layers is reported, not looped', () => {
  const r = mergeSources([layer('a', 'A=x${B}\n'), layer('b', 'B=y${A}\n')], {
    useProcessEnv: false,
  });
  assert.ok(r.errors.length >= 1, 'a cycle must be reported');
});

test('merge is usable directly with parsed entry lists', () => {
  const { parse } = require('../src/parser.js');
  const r = merge(
    [
      { name: 'x', result: parse('A=1\n') },
      { name: 'y', result: parse('B=2\n') },
    ],
    { useProcessEnv: false }
  );
  assert.deepStrictEqual(r.object, { A: '1', B: '2' });
});