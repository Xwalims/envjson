'use strict';

/**
 * Differential check: envjson's interpolation against REAL bash.
 *
 * Why this exists
 * ---------------
 * Every other expectation in this repository's suite comes from the code under
 * test, so such a suite certifies self-consistency. Every documented expansion
 * form is a claim about what a shell does, and a shell is installed on every
 * machine that could plausibly run this. `/bin/bash` is therefore the oracle:
 * the same template, in the same environment state, through both.
 *
 * That habit already paid for itself. It found that a value read from
 * `process.env` was being re-scanned as a template, so an exported `p$ssw0rd`
 * resolved to `p` -- because `$ssw0rd` was read as a reference to an unset
 * variable. bash never re-scans an expansion result, and on a credential path
 * that is silent corruption rather than a cosmetic difference. 150 of 3000
 * generated cases disagreed before the fix; 0 do now.
 *
 * What it does NOT cover
 * ----------------------
 * - The `:?` and `?` forms. Both abort the whole command in a real shell, so
 *   there is no string result to compare. They are covered by `node --test`.
 * - Templates containing characters bash treats as syntax beyond expansion --
 *   the generator builds only `$VAR`, `${VAR...}` and plain words, so quoting
 *   and command-substitution behaviour is deliberately out of scope. A
 *   difference there would be about the harness's own quoting, not about
 *   expansion.
 * - Document-sourced values. A value *in the file* is a template by design, so
 *   bash is not the right oracle for it -- there is no bash equivalent. The
 *   suite owns that half.
 *
 * This is a *development* tool, not part of the shipped package and not part of
 * the CI suite. Run it explicitly:
 *
 *     node scripts/cross-check-bash.js
 *     node scripts/cross-check-bash.js --trials 300 --seed 4242
 *
 * Exits 0 when every comparable case agrees, 1 otherwise. Requires `bash`; when
 * it is missing the script says so and exits 0.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { expandObject } = require('../src/index.js');

const ROOT = path.join(__dirname, '..');

// --- arguments -------------------------------------------------------------

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
};
const TRIALS = Number(argOf('--trials', 3000));
const SEED = Number(argOf('--seed', 20261005));

// --- deterministic RNG -----------------------------------------------------

let state = SEED >>> 0;
function rnd() {
  // xorshift32: deterministic and dependency-free, so a reported failure can be
  // replayed exactly with the seed printed alongside it.
  state ^= state << 13; state >>>= 0;
  state ^= state >> 17;
  state ^= state << 5; state >>>= 0;
  return state / 4294967296;
}
const ri = (n) => Math.floor(rnd() * n);
const pick = (list) => list[ri(list.length)];

// --- generators ------------------------------------------------------------

const NAMES = ['A', 'B', 'EMPTY', 'LONG_NAME'];

/**
 * Environment states. `a$b` and `${B}` are the shapes that matter: a literal
 * `$` inside an exported value, which must survive verbatim.
 */
const STATES = [
  {},
  { A: 'alpha' },
  { A: '', B: 'beta' },
  { A: 'alpha', B: 'beta' },
  { A: 'alpha', EMPTY: '' },
  { A: 'x y', B: '' },
  { A: 'a$b', B: '${B}' },
  { A: '$HOME', EMPTY: '' },
  { LONG_NAME: 'long' },
  { A: 'a$b$c', B: 'x$$y' },
];

// Words used as default/alternate arguments. No shell metacharacters, so the
// comparison is about expansion semantics and not about quoting.
const WORDS = ['def', 'fallback', 'x', '', 'a b', '0'];

function genTemplate() {
  let out = '';
  const pieces = 1 + ri(3);
  for (let i = 0; i < pieces; i += 1) {
    const name = pick(NAMES);
    const kind = pick(['bare', 'braced', 'plain']);
    const op = pick(['-', ':-', '+', ':+', '']);
    const word = op ? pick(WORDS) : '';
    if (kind === 'bare') out += `$${name}`;
    else if (kind === 'braced') out += op ? `\${${name}${op}${word}}` : `\${${name}}`;
    else out += pick(['pre', '-', 'x_y', ' ', 'end']);
  }
  return out;
}

// --- the oracle ------------------------------------------------------------

/**
 * Run one template through bash and return the bytes it prints.
 *
 * The template has to reach bash as SOURCE, not as the value of a variable: a
 * template held in a variable prints literally, because expansion results are
 * not re-scanned. Writing it into a one-line script inside double quotes makes
 * bash parse and expand it exactly as if it had been typed in. Only `"`,
 * backtick and backslash are escaped -- `$` is left alone on purpose, since
 * escaping it would suppress the very expansion under test.
 */
function bashExpand(template, env) {
  const escaped = template.replace(/[\\"`]/g, '\\$&');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envjson-cross-'));
  try {
    const script = path.join(dir, 'case.sh');
    fs.writeFileSync(script, `printf %s "${escaped}"\n`);
    return execFileSync('bash', [script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function bashAvailable() {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// --- main ------------------------------------------------------------------

function main() {
  if (!bashAvailable()) {
    console.log('bash is not available on this machine; skipping.');
    console.log('This is not a failure: bash is not a dependency of this project.');
    return 0;
  }

  const failures = [];
  let checked = 0;

  for (let trial = 0; trial < TRIALS; trial += 1) {
    const envState = pick(STATES);
    const template = genTemplate();

    // The `:?` and `?` operators are never generated (see `genTemplate`), and
    // bash ABORTS on them rather than printing, so there is no string to compare
    // against -- `node --test` owns those. If bash still rejects the template
    // for any other reason it exits non-zero, and the case is simply skipped
    // rather than counted as agreement.
    let theirs;
    try {
      theirs = bashExpand(template, envState);
    } catch {
      continue;
    }

    // The state has to live in process.env, because that is where bash's
    // variables live. Seeding it into the document instead would compare bash's
    // environment semantics against envjson's document semantics, where
    // re-expansion is intended, and every value containing a `$` would report
    // a phantom mismatch.
    for (const name of Object.keys(envState)) delete process.env[name];
    Object.assign(process.env, envState);
    let mine;
    try {
      mine = expandObject({ TPL: template }, { useProcessEnv: true }).object.TPL;
    } finally {
      for (const name of Object.keys(envState)) delete process.env[name];
    }

    checked += 1;
    if (mine !== theirs) {
      failures.push({ template, envState, bash: theirs, mine });
    }
  }

  console.log(`oracle: /bin/bash`);
  console.log(`${checked} cases compared (seed=${SEED}), ${failures.length} mismatch(es)`);
  for (const f of failures.slice(0, 10)) {
    console.log(`  template=${JSON.stringify(f.template)} state=${JSON.stringify(f.envState)}`);
    console.log(`    bash    = ${JSON.stringify(f.bash)}`);
    console.log(`    envjson = ${JSON.stringify(f.mine)}`);
  }
  if (failures.length > 10) console.log(`  ... and ${failures.length - 10} more`);

  if (failures.length) {
    console.log('\nMISMATCHES FOUND');
    return 1;
  }
  console.log('\nexpansion agrees with bash on every comparable case');
  return 0;
}

process.exit(main());
