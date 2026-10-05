'use strict';

const { InterpolationError } = require('./errors.js');
const { assignKey, hasKey, copyOwn } = require('./keysafe.js');

/**
 * Shell-style expansion, applied only to double-quoted and unquoted values.
 * Single-quoted values reach the output byte-for-byte.
 *
 * Supported forms:
 *   $VAR          bare name; unset -> empty string
 *   ${VAR}        braced name; unset -> empty string
 *   ${VAR:-def}   default when unset OR empty
 *   ${VAR-def}    default when unset (empty counts as set)
 *   ${VAR:?msg}   error when unset OR empty
 *   ${VAR?msg}    error when unset
 *   ${VAR:+word}  word when set AND non-empty, else nothing
 *   ${VAR+word}   word when set (empty counts as set), else nothing
 *   \$            a literal dollar sign
 *
 * References resolve lazily against the accumulator built so far, so a value
 * may point at a key defined by an earlier layer or an earlier line. Cycles are
 * detected by an active-resolution chain and raise instead of spinning.
 */
const MAX_DEPTH = 50;

function expand(text, lookup, options = {}) {
  const maxDepth = options.maxDepth || MAX_DEPTH;
  return expandString(String(text), lookup, [], maxDepth, options);
}

function expandString(text, lookup, chain, maxDepth, options) {
  if (chain.length > maxDepth) {
    throw new InterpolationError(
      `variable expansion nested deeper than ${maxDepth} levels: ${chain.join(' -> ')}`
    );
  }
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (ch === '$') {
      const ref = parseReference(text, i);
      if (ref) {
        out += resolveRef(ref, lookup, chain, maxDepth, options);
        i = ref.end;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Parse `$NAME` or `${...}` at `at`, or return null when it is not a reference. */
function parseReference(text, at) {
  if (text[at + 1] === '{') {
    const close = findClosingBrace(text, at + 1);
    if (close === -1) return null;
    const inner = text.slice(at + 2, close);
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(:?[-?+])?([\s\S]*?)\s*$/.exec(inner);
    if (!m) return null;
    const ref = {
      name: m[1],
      operator: m[2] || null,
      argument: m[3] === undefined ? '' : m[3],
      end: close + 1,
    };
    if (ref.operator === '-' || ref.operator === '?') {
      // A `:-` / `:?` / `-` / `?` form needs an argument; `${A?}` stays plain.
      //
      // That fallback is exactly what the shell does for the EMPTY word: bash
      // gives `${A-}` and `${A:-}` the variable's own value, which is what
      // dropping the operator yields. The `+` family is deliberately NOT in
      // this branch, because its empty word is meaningful and asymmetric --
      // `${A+}` and `${A:+}` both expand to the empty string, while the plain
      // `${A}` would expand to the value. Dropping the operator there would
      // turn a request for "nothing" into a request for the variable.
      if (ref.argument === '') return { ...ref, operator: null };
    }
    return ref;
  }
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(at));
  if (!m) return null;
  return { name: m[1], operator: null, argument: '', end: at + m[0].length };
}

function findClosingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function resolveRef(ref, lookup, chain, maxDepth, options) {
  const found = lookup(ref.name);
  // A Verbatim wrapper means the value came from process.env and is data, not a
  // template. It is unwrapped HERE, at the boundary, so every branch below sees
  // an ordinary string: `isEmpty` must test the real text (an exported empty
  // value has to count as empty for `:-` and `:?` to fire) and no operator form
  // has to know the wrapper exists.
  const verbatim = found instanceof Verbatim;
  const raw = verbatim ? found.text : found;
  const isSet = raw !== undefined && raw !== null;
  const isEmpty = isSet && raw === '';

  if (ref.operator === ':?' || ref.operator === '?') {
    const bad = ref.operator === ':?' ? !isSet || isEmpty : !isSet;
    if (bad) {
      throw new InterpolationError(`${ref.name}: ${ref.argument || 'is required'}`);
    }
  }

  let chosen;
  let fromArgument = false;
  if (ref.operator === ':-' && (!isSet || isEmpty)) {
    chosen = ref.argument;
    fromArgument = true;
  } else if (ref.operator === '-' && !isSet) {
    chosen = ref.argument;
    fromArgument = true;
  } else if (ref.operator === ':+' && isSet && !isEmpty) {
    // Alternate value: the WORD wins when the variable is set and non-empty.
    //
    // This is the mirror image of `:-`, and note what it does NOT fall
    // through to. Before this branch existed, `+` parsed to no operator at
    // all, so `${HOST:+localhost}` silently yielded HOST's own value -- the
    // one form where "the variable is fine" and "use this other thing" are
    // opposite outcomes, which makes the silent reading doubly wrong.
    chosen = ref.argument;
    fromArgument = true;
  } else if (ref.operator === '+' && isSet) {
    chosen = ref.argument;
    fromArgument = true;
  } else if (ref.operator === ':+' || ref.operator === '+') {
    // The negative half of the `+` family: unset, or set-but-empty for `:+`.
    // Both produce the empty string, never the variable's value. Falling
    // through to `isSet` here is the bug; it is spelled out as its own branch
    // so the asymmetry with `:-` is visible.
    return '';
  } else if (isSet) {
    chosen = raw;
  } else {
    chosen = '';
  }

  if (typeof chosen !== 'string' || chosen === '') return '';

  // A value that arrived verbatim from process.env is substituted and STOPPED.
  // This is the second half of the fix documented in makeLookup: bash expands a
  // reference and prints the result, it never runs that result back through
  // expansion.
  //
  // The branch that chose `chosen` is what decides, NOT whether the text happens
  // to equal the variable's own value. Comparing the two looks equivalent and is
  // not: with `P='$HOME'` exported, `${P+$HOME}` takes the `+` branch and picks
  // the WORD `$HOME`, which bash expands to a home directory. A text comparison
  // would see `chosen === raw`, conclude "this is P's value", and return the
  // literal `$HOME` instead. `fromArgument` records the actual branch, so that
  // case expands and a genuine value does not.
  if (fromArgument) {
    // The default text is a template and may itself contain references. It is
    // NEVER the variable's own value, so no cycle is possible here.
    return expandString(chosen, lookup, chain, maxDepth, options);
  }

  if (verbatim) return raw;

  // The value came from the variable. Re-expand it, guarding against a chain
  // that loops back to this name.
  if (chain.includes(ref.name)) {
    throw new InterpolationError(
      `self-referencing variable ${ref.name} (${chain.concat(ref.name).join(' -> ')})`
    );
  }
  return expandString(chosen, lookup, chain.concat(ref.name), maxDepth, options);
}

/**
 * Build the lookup used by `expand` from an object, optionally + process.env.
 *
 * VALUES FROM process.env ARE NOT TEMPLATES.
 *
 * The lookup distinguishes the two sources, and the distinction is load-bearing.
 * A value read from the document is itself a template, so re-expanding it is what
 * makes `A=${B}` / `B=${C}` resolve in any order -- deliberate, and documented. A
 * value read from process.env is NOT a template: it is data that happened to be
 * exported, and the shell never re-scans it.
 *
 *     export P='p$ssw0rd'
 *     printf %s "$P"          # bash prints: p$ssw0rd
 *
 * bash expands a REFERENCE and prints the result. It does not take that result
 * and run it through expansion a second time, so a literal `$` in a secret
 * survives. The old lookup returned the raw string and let the caller's
 * recursion re-expand it, which silently ate the `$`: `P='p$ssw0rd'` resolved to
 * `p`, because `$ssw0rd` was then read as a reference to an unset variable.
 * `${X}` in an exported value resolved to nothing, and `x$$y` became `x$y` --
 * the second `$` was parsed as the start of a reference. That value is a
 * plausible password or a token in an AWS secret, so this is data corruption on
 * the credential path, not a cosmetic diff.
 *
 * An environment value is therefore wrapped in {@link Verbatim}. It is still
 * substituted as a STRING -- `P='a:b'` in `U=${P}` yields `a:b`, not a parsed
 * object -- but its own `$` sequences are inert.
 *
 * A wrapper object rather than a property on the string itself: a primitive
 * string cannot carry a brand, since `Object.defineProperty` on one throws
 * `TypeError: Object.defineProperty called on non-object` in both strict and
 * sloppy mode. Boxing the value into a String would work but then `typeof`
 * changes to `object`, which every `typeof chosen !== 'string'` guard in this
 * file would then reject.
 *
 * The wrapper is built here, at the single point every lookup flows through,
 * rather than at each call site: `expandTemplates`, `merge` and any future caller
 * all share it, so none of them can reintroduce the bug.
 *
 * @param {object} source Own data map treated as templates.
 * @param {boolean} useProcessEnv Whether unset names may fall through to
 *   `process.env`.
 * @returns {(name: string) => (string|Verbatim|undefined)}
 */
function makeLookup(source, useProcessEnv) {
  return function lookup(name) {
    if (hasKey(source, name)) return source[name];
    if (useProcessEnv && process.env && process.env[name] !== undefined) {
      return new Verbatim(String(process.env[name]));
    }
    return undefined;
  };
}

/**
 * A substituted value that must never be scanned as a template.
 *
 * The class is the brand, so the test is an `instanceof` rather than a guess
 * about the text. A value cannot fake its way past this, and a genuine template
 * whose text happens to contain a reference is still expanded.
 */
class Verbatim {
  /** @param {string} text Raw value that is data, not a template. */
  constructor(text) {
    this.text = text;
  }
}

/** Does this template mention the key it is being expanded for? */
function referencesSelf(template, key) {
  // The operator class must include `+`, and it must include it the way the
  // parser does -- `[:?+-]` with the `+` last so it is a literal. `${A:+d}`
  // mentions A, and scoping A out is what stops `${A:+${A}}` from resolving
  // against its own previous value.
  const names =
    String(template).match(/\$\{?\s*[A-Za-z_][A-Za-z0-9_]*\s*[:?+\-]?/g) || [];
  return names.some((n) => n.replace(/^\$\{?\s*/, '').replace(/[:?+\-]\s*$/, '') === key);
}

/**
 * Expand `object` using a per-key template map.
 *
 * A key mapped to null/undefined is passed through untouched. That is how a
 * single-quoted value stays literal while its double-quoted neighbour expands.
 *
 * SELF-REFERENCES: when a template mentions the key it defines, that key is
 * removed from the lookup scope first. So `A=${A:-safe}` with no inherited A
 * falls back to `safe` rather than feeding on itself, and `A=${A}` with nothing
 * inherited yields the empty string. This matches shell assignment semantics,
 * where a variable always reads its PREVIOUS value.
 *
 * Indirect cycles (`A=x${B}` / `B=y${A}`) still hit the resolution-chain guard
 * inside `expand` and are reported as errors rather than spun on.
 */
function expandTemplates(object, templates, options = {}) {
  const useProcessEnv = options.useProcessEnv !== false;
  const maxPasses = options.maxPasses || MAX_DEPTH;
  let current = copyOwn(object);
  let errors = [];

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const base = makeLookup(current, useProcessEnv);
    const next = {};
    // Rebuilt per pass, and that is deliberate: the caller wants the failures
    // that are STILL failing, not every failure ever seen. A key whose
    // dependency only arrives in a later pass (a forward reference) stops
    // failing and must stop being reported, so the previous pass's list is
    // discarded rather than accumulated into.
    errors = [];
    let changed = false;

    for (const [key, value] of Object.entries(current)) {
      const template = templates.get(key);
      if (template === null || template === undefined) {
        assignKey(next, key, value);
        continue;
      }
      let lookup = base;
      if (referencesSelf(template, key)) {
        const scope = copyOwn(current);
        delete scope[key];
        lookup = makeLookup(scope, useProcessEnv);
      }
      try {
        const expanded = expand(template, lookup, options);
        if (expanded !== value) changed = true;
        assignKey(next, key, expanded);
      } catch (err) {
        // No cross-pass dedup here. `errors` is per-pass, so this branch sees
        // each key exactly once per pass and the push cannot duplicate -- but a
        // `seenErrors` set that outlived the pass did exactly that. It recorded
        // a key on the pass where it first failed and then suppressed every
        // later re-report, so a key that failed on EVERY pass was reported
        // exactly once, on the first one, and the list handed back at the end
        // was the last pass's -- which is empty for any key that failed again
        // in it. Combined with the per-pass reset that made `errors` come back
        // empty for any document that both expanded something AND had a
        // failing key, which is the overwhelmingly common shape: one
        // `${VAR:?msg}` guard plus any reference anywhere in the file.
        //
        // `errors` is the only signal a caller has that a required-variable
        // guard fired, and failing the run is the entire purpose of that guard.
        errors.push({ key, message: err.message });
        assignKey(next, key, value);
      }
    }

    current = next;
    if (!changed) break;
  }

  return { object: current, errors };
}

/**
 * Expand every value in `object` in place-safe fashion, returning a new object
 * plus the list of keys whose expansion threw. Every value is treated as a
 * template; use `expandTemplates` when some values must stay literal.
 */
function expandObject(object, options = {}) {
  const templates = new Map(Object.keys(object).map((k) => [k, object[k]]));
  return expandTemplates(object, templates, options);
}

module.exports = {
  expand,
  expandObject,
  expandTemplates,
  referencesSelf,
  makeLookup,
  parseReference,
  MAX_DEPTH,
};