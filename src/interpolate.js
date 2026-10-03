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
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(:?[-?])?([\s\S]*?)\s*$/.exec(inner);
    if (!m) return null;
    const ref = {
      name: m[1],
      operator: m[2] || null,
      argument: m[3] === undefined ? '' : m[3],
      end: close + 1,
    };
    if (ref.operator === '-' || ref.operator === '?') {
      // A `:-` / `:?` / `-` / `?` form needs an argument; `${A?}` stays plain.
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
  const raw = lookup(ref.name);
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
  } else if (isSet) {
    chosen = raw;
  } else {
    chosen = '';
  }

  if (typeof chosen !== 'string' || chosen === '') return '';

  if (fromArgument) {
    // The default text is a template and may itself contain references. It is
    // NEVER the variable's own value, so no cycle is possible here.
    return expandString(chosen, lookup, chain, maxDepth, options);
  }

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
 */
function makeLookup(source, useProcessEnv) {
  return function lookup(name) {
    if (hasKey(source, name)) return source[name];
    if (useProcessEnv && process.env && process.env[name] !== undefined) return process.env[name];
    return undefined;
  };
}

/** Does this template mention the key it is being expanded for? */
function referencesSelf(template, key) {
  const names = String(template).match(/\$\{?\s*[A-Za-z_][A-Za-z0-9_]*\s*[:?-]?/g) || [];
  return names.some((n) => n.replace(/^\$\{?\s*/, '').replace(/[:?-]\s*$/, '') === key);
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
  const seenErrors = new Set();

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const base = makeLookup(current, useProcessEnv);
    const next = {};
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
        if (!seenErrors.has(key)) {
          seenErrors.add(key);
          errors.push({ key, message: err.message });
        }
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