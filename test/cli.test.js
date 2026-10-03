'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { main, parseArgs, format, formatProperties, EXIT } = require('../src/cli.js');
const { DEFAULTS } = require('../src/defaults.js');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'envjson.js');

// --- tiny in-process IO harness -------------------------------------------
function run(argv) {
  let out = '';
  let err = '';
  const code = main(argv, {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'envjson-'));
}

function write(dir, name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

// --- argument parsing ------------------------------------------------------

test('defaults come from the single frozen DEFAULTS object', () => {
  const o = parseArgs([]);
  assert.strictEqual(o.format, DEFAULTS.format);
  assert.strictEqual(o.redact, DEFAULTS.redact);
  assert.strictEqual(o.dryRun, DEFAULTS.dryRun);
  assert.strictEqual(o.check, DEFAULTS.check);
  assert.deepStrictEqual(o.files, []);
  assert.ok(Object.isFrozen(DEFAULTS));
});

test('files, --env and --format parse as documented', () => {
  const o = parseArgs(['a.env', 'b.env', '--env', 'K=V', '--format', 'ini']);
  assert.deepStrictEqual(o.files, ['a.env', 'b.env']);
  assert.deepStrictEqual(o.env, [['K', 'V']]);
  assert.strictEqual(o.format, 'ini');
});

test('inline --format=ndjson and the --ndjson alias both work', () => {
  assert.strictEqual(parseArgs(['--format=ndjson']).format, 'ndjson');
  assert.strictEqual(parseArgs(['--jsonl']).format, 'ndjson');
  assert.strictEqual(parseArgs(['--json']).format, 'json');
});

test('--env splits on the first = only', () => {
  assert.deepStrictEqual(parseArgs(['--env', 'URL=a=b']).env, [['URL', 'a=b']]);
});

test('--redact-keys parses a comma list', () => {
  assert.deepStrictEqual(parseArgs(['--redact-keys', 'a, b ,c']).redactKeys, ['a', 'b', 'c']);
});

// A flag that takes a value must accept BOTH spellings and produce the same
// option. `--redact-keys` used to read argv[i] instead of the value `take()`
// had already resolved, so the inline form consumed the flag's own name as a
// mask pattern and the caller's key list was silently discarded.
test('every value-taking flag behaves the same in inline and separate form', () => {
  const pairs = [
    [['--redact-keys', 'a,b'], ['--redact-keys=a,b'], (o) => o.redactKeys],
    [['--format', 'ini'], ['--format=ini'], (o) => o.format],
    [['--output', 'x.json'], ['--output=x.json'], (o) => o.out],
    [['--env', 'A=1'], ['--env=A=1'], (o) => o.env],
  ];
  for (const [separate, inline, pick] of pairs) {
    assert.deepStrictEqual(
      pick(parseArgs(inline)),
      pick(parseArgs(separate)),
      `${inline.join(' ')} must behave like ${separate.join(' ')}`
    );
  }
});

test('an inline --redact-keys value is split on commas, not on the flag name', () => {
  assert.deepStrictEqual(parseArgs(['--redact-keys=a,b']).redactKeys, ['a', 'b']);
});

test('a flag name never leaks into the parsed value', () => {
  for (const argv of [
    ['--redact-keys=session'],
    ['--format=ini'],
    ['--output=x.json'],
    ['--env=A=1'],
  ]) {
    const dump = JSON.stringify(parseArgs(argv));
    assert.doesNotMatch(dump, /--(redact-keys|format|output|env)=/, `${argv} leaked the flag name`);
  }
});

test('--redact-keys=VALUE still masks the key end to end', () => {
  const r = run(['--env', 'SESSION=abc', '--redact-keys=session', '--redact']);
  assert.strictEqual(r.code, EXIT.OK);
  assert.strictEqual(JSON.parse(r.out).SESSION, '***REDACTED***');
});

test('an odd key name is treated as a literal name, end to end and without crashing', () => {
  // `(` used to be spliced into the matcher verbatim and threw an uncaught
  // SyntaxError, killing the process instead of exiting 2. Escaping makes every
  // name match only itself, so this is now simply a weird key name.
  const r = run(['--env', 'SESSION=abc', '--redact-keys', '(']);
  assert.strictEqual(r.code, EXIT.OK);
  assert.doesNotThrow(() => JSON.parse(r.out));
});

test('a key name of `.*` masks only itself and leaves the rest readable', () => {
  // The nastiest version of the same bug: `.*` used to match every key, so a
  // config dump asked to mask one extra key came back with nothing readable.
  const r = run(['--env', 'SESSION=abc', '--env', 'PORT=8080', '--redact-keys', '.*']);
  assert.strictEqual(r.code, EXIT.OK);
  const o = JSON.parse(r.out);
  assert.strictEqual(o.PORT, '8080');
  assert.strictEqual(o.SESSION, 'abc');
});

test('--redact-keys= with an empty value is a usage error', () => {
  assert.throws(() => parseArgs(['--redact-keys=']), /--redact-keys requires a value/);
});

test('-- ends flag parsing so dotfiles can be passed', () => {
  const o = parseArgs(['--', '--weird-file.env']);
  assert.deepStrictEqual(o.files, ['--weird-file.env']);
});

test('an unknown flag is a usage error', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('a bad --format value is a usage error', () => {
  assert.throws(() => parseArgs(['--format', 'yaml']), /--format must be one of/);
});

test('a flag missing its value is a usage error', () => {
  assert.throws(() => parseArgs(['--format']), /--format requires a value/);
  assert.throws(() => parseArgs(['--env', 'nokey']), /expects KEY=VALUE/);
});

// --- formatting ------------------------------------------------------------

test('json output is pretty-printed with a trailing newline', () => {
  assert.strictEqual(format({ A: '1' }, 'json'), '{\n  "A": "1"\n}\n');
});

test('ndjson output is one JSON pair per line', () => {
  assert.strictEqual(format({ A: '1', B: '2' }, 'ndjson'), '"A": "1"\n"B": "2"\n');
});

test('ndjson output of an empty object is empty', () => {
  assert.strictEqual(format({}, 'ndjson'), '');
});

test('properties output quotes separators and whitespace', () => {
  assert.strictEqual(formatProperties({ A: 'x', B: 'a b', C: 'n=1' }), 'A=x\nB=a b\nC=n\\=1\n');
});

test('ini output groups dotted keys into sections', () => {
  const text = format({ TOP: '1', 'sec.a': '2' }, 'ini');
  assert.strictEqual(text, 'TOP = 1\n\n[sec]\na = 2\n');
});

test('ini output escapes a # inside a value so it round-trips', () => {
  const text = format({ COLOR: '#ff8800' }, 'ini');
  assert.strictEqual(text, 'COLOR = "#ff8800"\n');
});

// --- in-process CLI behaviour ---------------------------------------------

test('no arguments is a usage error (exit 2)', () => {
  const r = run([]);
  assert.strictEqual(r.code, EXIT.USAGE);
  assert.match(r.err, /no input files/);
});

test('an unknown flag exits 2 through main()', () => {
  const r = run(['--bogus']);
  assert.strictEqual(r.code, EXIT.USAGE);
});

test('a missing file exits 2', () => {
  const r = run([path.join(os.tmpdir(), 'definitely-not-here-envjson.env')]);
  assert.strictEqual(r.code, EXIT.USAGE);
  assert.match(r.err, /cannot read/);
});

test('--help exits 0 and prints usage', () => {
  const r = run(['--help']);
  assert.strictEqual(r.code, EXIT.OK);
  assert.match(r.out, /Usage:/);
  assert.match(r.out, /--fail-on-change/);
});

test('--version prints the package version', () => {
  const r = run(['--version']);
  assert.strictEqual(r.code, EXIT.OK);
  assert.strictEqual(r.out.trim(), 'envjson 0.1.0');
});

test('--dry-run resolves but prints nothing', () => {
  const r = run(['--env', 'A=1', '--dry-run']);
  assert.strictEqual(r.code, EXIT.OK);
  assert.strictEqual(r.out, '');
});

test('--stats writes a summary to stderr, never stdout', () => {
  const r = run(['--env', 'A=1', '--env', 'B=2', '--stats']);
  assert.strictEqual(r.code, EXIT.OK);
  assert.deepStrictEqual(JSON.parse(r.out), { A: '1', B: '2' });
  // Repeated --env flags build ONE layer, in flag order.
  assert.match(r.err, /stats: layers=1 \[--env\]/);
  assert.match(r.err, /keys=2/);
  assert.match(r.err, /overrides=0/);
});

test('--stats counts each file as its own layer', () => {
  const dir = tmpdir();
  const a = write(dir, 'a.env', 'A=1\n');
  const b = write(dir, 'b.env', 'B=2\n');
  const r = run([a, b, '--stats']);
  assert.match(r.err, /stats: layers=2/);
  assert.match(r.err, /keys=2/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--explain reports provenance on stderr', () => {
  const r = run(['--env', 'A=1', '--explain']);
  assert.match(r.err, /explain:/);
  assert.match(r.err, /A = "1"/);
  assert.strictEqual(JSON.parse(r.out).A, '1');
});

test('stdout stays valid JSON when --explain and --stats are combined', () => {
  const r = run(['--env', 'A=1', '--explain', '--stats']);
  assert.doesNotThrow(() => JSON.parse(r.out));
});

test('a required-variable failure exits 2', () => {
  const r = run(['--env', 'X=${NOPE:?NOPE must be set}']);
  assert.strictEqual(r.code, EXIT.USAGE);
  assert.match(r.err, /NOPE must be set/);
});

test('--redact masks secrets but leaves other values readable', () => {
  const r = run(['--env', 'API_TOKEN=secret123', '--env', 'PORT=8080', '--redact']);
  const o = JSON.parse(r.out);
  assert.strictEqual(o.API_TOKEN, '***REDACTED***');
  assert.strictEqual(o.PORT, '8080');
});

test('--redact-keys masks an extra custom key', () => {
  const r = run(['--env', 'SESSION=abc', '--redact-keys', 'session']);
  assert.strictEqual(JSON.parse(r.out).SESSION, '***REDACTED***');
});

test('-o writes to a file and prints nothing to stdout', () => {
  const dir = tmpdir();
  const out = path.join(dir, 'out.json');
  const src = write(dir, 'a.env', 'A=1\n');
  const r = run([src, '-o', out]);
  assert.strictEqual(r.code, EXIT.OK);
  assert.strictEqual(r.out, '');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { A: '1' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--fail-on-change exits 1 when a layer overrides a value', () => {
  const dir = tmpdir();
  const a = write(dir, 'a.env', 'A=1\n');
  const b = write(dir, 'b.env', 'A=2\n');
  assert.strictEqual(run([a, b, '--fail-on-change']).code, EXIT.CHANGED);
  assert.strictEqual(run([a, b]).code, EXIT.OK);
  assert.strictEqual(run([a, '--fail-on-change']).code, EXIT.OK);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--fail-on-change stays 0 when a pure ${VAR} layer keeps the inherited value', () => {
  const dir = tmpdir();
  const a = write(dir, 'a.env', 'PORT=8080\n');
  const b = write(dir, 'b.env', 'PORT=${PORT}\n');
  assert.strictEqual(run([a, b, '--fail-on-change']).code, EXIT.OK);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--check exits 3 when the merged result drifts from the first file', () => {
  const dir = tmpdir();
  const a = write(dir, 'a.env', 'A=1\nB=1\n');
  const b = write(dir, 'b.env', 'A=1\nB=2\n');
  assert.strictEqual(run([a, b, '--check']).code, EXIT.DRIFT);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--check exits 0 when the first file already matches the merge', () => {
  const dir = tmpdir();
  const a = write(dir, 'a.env', 'A=1\nB=2\n');
  const b = write(dir, 'b.env', 'A=1\n');
  assert.strictEqual(run([a, b, '--check']).code, EXIT.OK);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--check exits 0 on a single file that contains a single-quoted value', () => {
  // The baseline must go through the same quote rules as the merge, otherwise
  // a literal ${VAR} looks like drift.
  const dir = tmpdir();
  const a = write(dir, 'a.env', 'BASE=x\nLIT=\'literal ${BASE}\'\nD="real ${BASE}"\n');
  const r = run([a, '--check']);
  assert.strictEqual(r.code, EXIT.OK, r.err);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--check ignores key ORDER, only value drift matters', () => {
  const dir = tmpdir();
  const a = write(dir, 'a.env', 'A=1\nB=2\n');
  const b = write(dir, 'b.env', 'B=2\n');
  assert.strictEqual(run([a, b, '--check']).code, EXIT.OK);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--check still reports drift when a later layer changes a value', () => {
  const dir = tmpdir();
  const a = write(dir, 'a.env', 'A=1\nB=2\n');
  const b = write(dir, 'b.env', 'B=99\n');
  assert.strictEqual(run([a, b, '--check']).code, EXIT.DRIFT);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- end-to-end: the real bin, real process exit codes --------------------

test('e2e: the real bin emits JSON and exits 0', () => {
  const dir = tmpdir();
  const f = write(dir, '.env', 'NAME=envjson\nPORT=8080\n');
  const r = spawnSync(process.execPath, [BIN, f], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout), { NAME: 'envjson', PORT: '8080' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('e2e: bin propagates exit 2 for a usage error', () => {
  const r = spawnSync(process.execPath, [BIN, '--bogus'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /unknown option/);
});

test('e2e: bin propagates exit 2 when no input is given', () => {
  const r = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
});

test('e2e: bin propagates exit 1 with --fail-on-change', () => {
  const dir = tmpdir();
  const a = write(dir, 'a.env', 'A=1\n');
  const b = write(dir, 'b.env', 'A=2\n');
  const bad = spawnSync(process.execPath, [BIN, a, b, '--fail-on-change'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  const good = spawnSync(process.execPath, [BIN, a, b], { encoding: 'utf8' });
  assert.strictEqual(good.status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('e2e: bin propagates exit 3 with --check on drift', () => {
  const dir = tmpdir();
  const a = write(dir, 'a.env', 'A=1\n');
  const b = write(dir, 'b.env', 'A=9\n');
  const r = spawnSync(process.execPath, [BIN, a, b, '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('e2e: bin is executable and has a shebang', () => {
  const r = spawnSync(BIN, ['--version'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), 'envjson 0.1.0');
  assert.ok(fs.readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node'));
});

test('e2e: BOM, quotes and = in values survive a real run', () => {
  const dir = tmpdir();
  const f = write(dir, '.env', '\uFEFFexport URL=a=b\nLIT=\'a\\nb\'\nDL="x\\ny"\n');
  const r = spawnSync(process.execPath, [BIN, f], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.URL, 'a=b');
  assert.strictEqual(o.LIT, 'a\\nb');
  assert.strictEqual(o.DL, 'x\ny');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('e2e: --format ndjson from the real bin', () => {
  const dir = tmpdir();
  const f = write(dir, '.env', 'A=1\nB=2\n');
  const r = spawnSync(process.execPath, [BIN, f, '--format', 'ndjson'], { encoding: 'utf8' });
  assert.strictEqual(r.stdout, '"A": "1"\n"B": "2"\n');
  fs.rmSync(dir, { recursive: true, force: true });
});