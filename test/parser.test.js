'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parse,
  toObject,
  detectFormat,
  isPureReference,
} = require('../src/parser.js');
const { format } = require('../src/cli.js');

test('parses simple KEY=value pairs', () => {
  const o = toObject(parse('A=1\nB=2\n'));
  assert.deepStrictEqual(o, { A: '1', B: '2' });
});

test('splits on the FIRST = only and keeps = inside the value', () => {
  const o = toObject(parse('URL=a=b=c\nQUERY=key=value&x=1\n'));
  assert.strictEqual(o.URL, 'a=b=c');
  assert.strictEqual(o.QUERY, 'key=value&x=1');
});

test('accepts an optional "export " prefix without eating export-like keys', () => {
  const o = toObject(parse('export A=1\nexport\tB=2\nexported_key=3\nexport=4\n'));
  assert.strictEqual(o.A, '1');
  assert.strictEqual(o.B, '2');
  assert.strictEqual(o.exported_key, '3');
  assert.strictEqual(o.export, '4');
});

test('accepts bare keys with no = sign, yielding an empty value', () => {
  const o = toObject(parse('DEBUG\n'));
  assert.strictEqual(o.DEBUG, '');
});

test('accepts keys with dots and dashes', () => {
  const o = toObject(parse('app.db.host=localhost\nlog-level=debug\n'));
  assert.strictEqual(o['app.db.host'], 'localhost');
  assert.strictEqual(o['log-level'], 'debug');
});

test('single-quoted values are literal: no escapes, no interpolation', () => {
  const o = toObject(parse("A='raw\\ntext'\nB='${HOME}'\n"));
  assert.strictEqual(o.A, 'raw\\ntext');
  assert.strictEqual(o.B, '${HOME}');
});

test('a backslash inside single quotes stays literal and cannot escape the quote', () => {
  // Source text:  PATH_LIKE='C:\Users\me\bin'
  // Parsed value:  C:\Users\me\bin   (backslashes untouched)
  const o = toObject(parse("PATH_LIKE='C:\\Users\\me\\bin'\n"));
  assert.strictEqual(o.PATH_LIKE, 'C:\\Users\\me\\bin');
});

test("a backslash cannot escape the closing single quote", () => {
  // Source text:  A='tail\'
  // The \ is data, so the quote closes and the value ends with a backslash.
  const o = toObject(parse("A='tail\\'\nB=2\n"));
  assert.strictEqual(o.A, 'tail\\');
  assert.strictEqual(o.B, '2');
});

test('a backslash IS processed in a double-quoted value', () => {
  const o = toObject(parse('A="C:\\\\dir"\n'));
  assert.strictEqual(o.A, 'C:\\dir');
});

test('double-quoted values process \\ \\n \\t and \\"', () => {
  const o = toObject(parse('A="line1\\nline2"\nB="a\\tb"\nC="say \\"hi\\""\nD="back\\\\slash"\n'));
  assert.strictEqual(o.A, 'line1\nline2');
  assert.strictEqual(o.B, 'a\tb');
  assert.strictEqual(o.C, 'say "hi"');
  assert.strictEqual(o.D, 'back\\slash');
});

test('an unknown escape inside double quotes keeps both characters', () => {
  const o = toObject(parse('A="keep\\qhere"\n'));
  assert.strictEqual(o.A, 'keep\\qhere');
});

test('interpolation applies to double-quoted values but not single-quoted ones', () => {
  const result = parse('BASE=/srv\nD="in/${BASE}/x"\nS=\'not/${BASE}\'\nU=${BASE}\n');
  const o = toObject(result);
  assert.strictEqual(result.entries[1].expression, 'in/${BASE}/x');
  assert.strictEqual(result.entries[2].expression, null);
  assert.strictEqual(result.entries[3].expression, '${BASE}');
});

test('unquoted values are trimmed and run to end of line', () => {
  const o = toObject(parse('A=   spaced value   \n'));
  assert.strictEqual(o.A, 'spaced value');
});

test('# is NOT a comment in an unquoted value without a leading space', () => {
  const o = toObject(parse('COLOR=#ff8800\nHASH=abc#def\n'));
  assert.strictEqual(o.COLOR, '#ff8800');
  assert.strictEqual(o.HASH, 'abc#def');
});

test('a # after whitespace DOES start a comment on an unquoted value', () => {
  const o = toObject(parse('A=value  # trailing comment\nB=value ; also this\n'));
  assert.strictEqual(o.A, 'value');
  assert.strictEqual(o.B, 'value');
});

test('full-line comments and blank lines are ignored', () => {
  const o = toObject(parse('# top\n\n; also a comment\n  # indented\nA=1\n'));
  assert.deepStrictEqual(o, { A: '1' });
});

test('multiline double-quoted values are supported', () => {
  const src = 'KEY="-----BEGIN-----\nline2\nline3\n-----END-----"\nAFTER=2\n';
  const o = toObject(parse(src));
  assert.strictEqual(o.KEY, '-----BEGIN-----\nline2\nline3\n-----END-----');
  assert.strictEqual(o.AFTER, '2');
});

test('multiline single-quoted values are supported', () => {
  const src = "KEY='one\ntwo'\nAFTER=2\n";
  const o = toObject(parse(src));
  assert.strictEqual(o.KEY, 'one\ntwo');
  assert.strictEqual(o.AFTER, '2');
});

test('a # inside a quoted value is data, not a comment', () => {
  const o = toObject(parse('A="has # hash"\n'));
  assert.strictEqual(o.A, 'has # hash');
});

test('a leading BOM is stripped from the first key', () => {
  const result = parse('\uFEFFA=1\nB=2\n');
  assert.strictEqual(result.hadBom, true);
  assert.deepStrictEqual(toObject(result), { A: '1', B: '2' });
});

test('duplicate keys: last one wins, and duplicates are reported', () => {
  const result = parse('A=1\nB=2\nA=3\n');
  assert.strictEqual(toObject(result).A, '3');
  assert.strictEqual(result.duplicates.length, 1);
  assert.deepStrictEqual(
    { key: result.duplicates[0].key, line: result.duplicates[0].line, previousLine: result.duplicates[0].previousLine },
    { key: 'A', line: 3, previousLine: 1 }
  );
});

test('CRLF line endings parse the same as LF', () => {
  const o = toObject(parse('A=1\r\nB="x\r\ny"\r\n'));
  assert.strictEqual(o.A, '1');
  assert.strictEqual(o.B, 'x\ny');
});

test('rejects a line with no key before =', () => {
  assert.throws(() => parse('=1\n'), /missing key/);
});

test('rejects an invalid key', () => {
  assert.throws(() => parse('9BAD=1\n'), /invalid key/);
  assert.throws(() => parse('BAD KEY=1\n'), /invalid key/);
});

test('rejects an unterminated quoted value', () => {
  assert.throws(() => parse('A="oops\n'), /unterminated/);
});

test('rejects junk after a closing quote', () => {
  assert.throws(() => parse('A="x" junk\n'), /unexpected/);
});

test('detects format from the filename', () => {
  assert.strictEqual(detectFormat('A=1', '.env'), 'dotenv');
  assert.strictEqual(detectFormat('A=1', '.env.local'), 'dotenv');
  assert.strictEqual(detectFormat('[s]\nk=v', 'app.ini'), 'ini');
  assert.strictEqual(detectFormat('a.b=1', 'x.properties'), 'properties');
});

test('detects format from content when there is no filename', () => {
  assert.strictEqual(detectFormat('[server]\nport=80', null), 'ini');
  assert.strictEqual(detectFormat('PORT=80', null), 'dotenv');
});

test('an explicit format overrides detection', () => {
  assert.strictEqual(detectFormat('[s]\nk=v', '.env', 'properties'), 'properties');
});

test('rejects an unknown explicit format', () => {
  assert.throws(() => detectFormat('A=1', '.env', 'yaml'), /unknown format/);
});

test('isPureReference is true only for a bare ${VAR}', () => {
  assert.strictEqual(isPureReference('${A}'), true);
  assert.strictEqual(isPureReference('${A:-d}'), false);
  assert.strictEqual(isPureReference('${A:-d}'), false);
  assert.strictEqual(isPureReference('x${A}'), false);
  assert.strictEqual(isPureReference('${A}x'), false);
  assert.strictEqual(isPureReference('plain'), false);
});

test('ini section headers round-trip through dotted keys', () => {
  const result = parse('[server]\nport=80\nhost=localhost\n', { format: 'ini' });
  const o = toObject(result);
  assert.strictEqual(o['server.port'], '80');
  assert.strictEqual(o['server.host'], 'localhost');
});

test('properties files keep dots in the key name', () => {
  const o = toObject(parse('app.db.host=h\n', { format: 'properties' }));
  assert.strictEqual(o['app.db.host'], 'h');
});

test('empty input produces an empty object', () => {
  assert.deepStrictEqual(toObject(parse('')), {});
});

// --- .properties, verified against java.util.Properties ------------------
// Every expectation below was checked against java.util.Properties itself
// (openjdk/jdk, Properties.java: LineReader.readLine, load0, loadConvert,
// saveConvert, store). The two bugs these cover:
//   * the reader had no escape handling at all, so a file written by
//     --format properties came back with doubled backslashes and literal
//     `\#`, `\\t`, `\\n`;
//   * it also ignored continuation lines, truncating a value at the first
//     physical line.

test('properties: escapes are decoded, so the writer round-trips', () => {
  const o = toObject(parse('a\\=b=v\nc\\td=e\\tf\ng=h\\ni\n', { format: 'properties' }));
  assert.strictEqual(o['a=b'], 'v');
  assert.strictEqual(o['c\td'], 'e\tf');
  assert.strictEqual(o.g, 'h\ni');
});

test('properties: an unknown escape stands for the character itself', () => {
  // java.util.Properties#loadConvert: `\#`, `\=`, `\!`, `\:` and any other
  // \c all decode to c. This is what keeps a separator literal.
  assert.deepStrictEqual(toObject(parse('k=a\\=b\n', { format: 'properties' })), { k: 'a=b' });
  assert.deepStrictEqual(toObject(parse('k=a\\#b\n', { format: 'properties' })), { k: 'a#b' });
  assert.deepStrictEqual(toObject(parse('k=a\\!b\n', { format: 'properties' })), { k: 'a!b' });
  assert.deepStrictEqual(toObject(parse('k=a\\:b\n', { format: 'properties' })), { k: 'a:b' });
  assert.deepStrictEqual(toObject(parse('k=a\\\\b\n', { format: 'properties' })), { k: 'a\\b' });
});

test('properties: \\uXXXX is decoded', () => {
  assert.deepStrictEqual(toObject(parse('k=\\u00e4\\u0041\n', { format: 'properties' })), {
    k: '\u00e4A',
  });
});

test('properties: a backslash at end of line continues onto the next', () => {
  assert.deepStrictEqual(toObject(parse('k=one\\\n  two\n', { format: 'properties' })), {
    k: 'onetwo',
  });
  assert.deepStrictEqual(toObject(parse('k=a\\\\\n', { format: 'properties' })), {
    k: 'a\\',
  });
});

test('properties: the key ends at the first unescaped = : or space', () => {
  assert.deepStrictEqual(toObject(parse('a:b=c\n', { format: 'properties' })), { a: 'b=c' });
  assert.deepStrictEqual(toObject(parse('a =b\n', { format: 'properties' })), { a: 'b' });
  assert.deepStrictEqual(toObject(parse('a: b\n', { format: 'properties' })), { a: 'b' });
  // `KEY value` has no `=` or `:` anywhere, but load0 still takes the value:
  // the whitespace branch sets `valueStart` (line 437) and the loadConvert at
  // line 458 is UNCONDITIONAL. `hasSep` is assigned at 434/450 and read once at
  // 449, but it never gates the result -- it is dead state. So Java loads
  // this as KEY=value, not as a bare key. An earlier version of this test
  // asserted the empty value on the strength of that flag; the flag says
  // nothing of the sort.
  assert.deepStrictEqual(toObject(parse('KEY value\n', { format: 'properties' })), { KEY: 'value' });
  assert.deepStrictEqual(toObject(parse('KEY  value\n', { format: 'properties' })), { KEY: 'value' });
  assert.deepStrictEqual(toObject(parse('KEY\tvalue\n', { format: 'properties' })), { KEY: 'value' });
  // A line of only a key does yield an empty value -- there is nothing left
  // after the key for valueStart to point at.
  assert.deepStrictEqual(toObject(parse('KEY\n', { format: 'properties' })), { KEY: '' });
  assert.deepStrictEqual(toObject(parse('KEY   \n', { format: 'properties' })), { KEY: '' });
});

test('properties: only # and ! start a comment line, and ; is data', () => {
  const o = toObject(parse('# c\n! c\n;data\nK=v\n', { format: 'properties' }));
  assert.strictEqual(o[';data'], '');
  assert.strictEqual(o.K, 'v');
});

test('properties: an empty key is legal, as in java.util.Properties', () => {
  assert.deepStrictEqual(toObject(parse('=v\n', { format: 'properties' })), { '': 'v' });
});

test('properties: an astral character escapes as a surrogate PAIR', () => {
  // saveConvert walks the string with charAt, and a Java String is UTF-16, so
  // U+10000 is two chars (D800 DC00) and must become TWO escapes. Emitting a
  // single \\u10000 would be a value no Java tool can read back.
  assert.strictEqual(format({ k: '\u{10000}' }, 'properties'), 'k=\\uD800\\uDC00\n');
  // and the pair reads back as the one astral character
  assert.deepStrictEqual(toObject(parse('k=\\uD800\\uDC00\n', { format: 'properties' })), {
    k: '\u{10000}',
  });
  // a LONE surrogate escape stays a lone surrogate instead of throwing
  assert.deepStrictEqual(toObject(parse('k=\\uD800\n', { format: 'properties' })), {
    k: '\ud800',
  });
});

test('properties: only space, tab and form feed are leading whitespace', () => {
  // String#trimStart would swallow NBSP here and silently rename the key.
  assert.deepStrictEqual(toObject(parse('\u00a0K=v\n', { format: 'properties' })), {
    '\u00a0K': 'v',
  });
  assert.deepStrictEqual(toObject(parse('\u3000K=v\n', { format: 'properties' })), {
    '\u3000K': 'v',
  });
  assert.deepStrictEqual(toObject(parse(' \tK=v\n', { format: 'properties' })), { K: 'v' });
});

test('properties: an escaped separator keeps a dotted-looking key whole', () => {
  // The writer escapes every space in a KEY, which is what stops load0 from
  // treating it as the separator.
  assert.deepStrictEqual(toObject(parse('a\\ b=v\n', { format: 'properties' })), {
    'a b': 'v',
  });
});