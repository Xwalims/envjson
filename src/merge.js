'use strict';

const { parse, toObject, isPureReference } = require('./parser.js');
const { expand, makeLookup, referencesSelf, MAX_DEPTH } = require('./interpolate.js');
const { assignKey, hasKey, copyOwn } = require('./keysafe.js');

/**
 * Accept a plain object OR a list of [key, value] pairs (which is what the CLI
 * collects from repeated --env flags) and normalize to entry objects.
 */
function toEntries(values) {
  const pairs = Array.isArray(values) ? values : Object.entries(values);
  return pairs.map(([key, value]) => ({
    key,
    value,
    line: null,
    quoted: null,
    exported: false,
    expression: value,
  }));
}

/**
 * Merge layers left-to-right; a later layer wins.
 *
 * PRECEDENCE
 *   A key defined by a later layer overrides the same key from an earlier one.
 *
 * THE PURE-REFERENCE RULE (the one that needs spelling out)
 *   A layer value that is nothing but `${VAR}` -- no default, no `:-`, no `?` --
 *   is treated as a REQUEST to resolve VAR, not as an override. If the key
 *   already has a value from an earlier layer, that earlier value is kept. If it
 *   does not, the layer value stands and resolves normally.
 *
 *   So `PORT=${PORT}` in an override file means "keep whatever the base file
 *   said" instead of blanking it out, which is the entire point of an override
 *   layer. Everything else is a real override, including a single-quoted
 *   `'${PORT}'` (literal, hence a genuine override) and `${PORT:-8080}`.
 *
 * SELF-REFERENCES
 *   A template that names the key it defines reads that key's PREVIOUS value
 *   (the one from earlier layers), never its own new text. That is shell
 *   assignment semantics: `PORT=${PORT:-3000}` over an inherited `PORT=8080`
 *   resolves to 8080, and over nothing at all it falls back to 3000.
 *
 * ORDER OF OPERATIONS
 *   1. Precedence is decided per entry, from the key's existence and the
 *      pure-reference rule.
 *   2. The RAW text is committed. Nothing is resolved yet, so a reference to a
 *      key defined further down still works.
 *   3. One final pass resolves every committed template against the finished
 *      object, with each self-reference rewritten to its inherited value.
 *      Chained references recurse, so `A=${B}` / `B=${C}` / `C=final` resolves
 *      no matter which order the keys appear in.
 *   4. A key whose template fails to resolve is reported in `errors` and dropped
 *      from the output; its siblings are unaffected.
 *
 * Every decision is recorded in `changes` so `--fail-on-change` and `--explain`
 * can report it.
 */
function merge(layers, options = {}) {
  const useProcessEnv = options.useProcessEnv !== false;
  const maxDepth = options.maxDepth || MAX_DEPTH;

  const out = {};
  const provenance = {};
  const inherited = {};
  const templates = new Map();
  const changes = [];
  const duplicates = [];
  const failedKeys = new Set();

  layers.forEach((layer, index) => {
    const name = layer.name || `layer${index + 1}`;
    const entries = layer.result
      ? layer.result.entries
      : toEntries(layer.values || layer.env || {});

    if (layer.result && layer.result.duplicates) {
      for (const dup of layer.result.duplicates) {
        duplicates.push({ ...dup, file: name });
      }
    }

    for (const entry of entries) {
      const key = entry.key;
      const rawValue = entry.value;
      const template = entry.quoted === 'single' ? null : entry.expression;
      const exists = hasKey(out, key);

      // --- 1. precedence ------------------------------------------------
      if (exists && template !== null && isPureReference(template)) {
        const previous = provenance[key];
        const refName = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(template.trim())[1];
        const resolved = makeLookup(out, false)(refName);
        changes.push({
          key,
          kind: 'kept',
          file: name,
          reason:
            resolved !== undefined
              ? `pure ${template} resolved to existing ${refName}`
              : `pure ${template} did not resolve; inherited value retained`,
          from: previous.file,
          fromLine: previous.line,
          to: name,
          toLine: entry.line,
        });
        continue;
      }

      if (exists) {
        changes.push({
          key,
          kind: 'override',
          file: name,
          reason: 'later layer wins',
          from: provenance[key].file,
          fromLine: provenance[key].line,
          fromValue: out[key],
          to: name,
          toLine: entry.line,
          toValue: rawValue,
        });
      } else {
        changes.push({
          key,
          kind: 'add',
          file: name,
          reason: 'first definition',
          to: name,
          toLine: entry.line,
        });
      }

      // --- 2. commit raw, remember what this key used to be -------------
      if (exists) assignKey(inherited, key, out[key]);
      else delete inherited[key];
      assignKey(out, key, rawValue);
      templates.set(key, template);
      assignKey(provenance, key, { file: name, line: entry.line, quoted: entry.quoted, template });
    }
  });

  // --- 3. resolve every template against the finished object -------------
  const scope = copyOwn(out);
  const object = {};
  const errors = [];

  for (const key of Object.keys(out)) {
    const template = templates.get(key);
    if (template === null) {
      assignKey(object, key, out[key]);
      continue;
    }
    const local = copyOwn(scope);
    if (referencesSelf(template, key)) {
      if (hasKey(inherited, key)) {
        assignKey(local, key, inherited[key]);
      } else {
        delete local[key];
      }
    }
    try {
      assignKey(object, key, expand(template, makeLookup(local, useProcessEnv), { maxDepth }));
    } catch (err) {
      failedKeys.add(key);
      errors.push({ key, message: err.message });
    }
  }

  return {
    object,
    provenance,
    changes,
    duplicates,
    errors,
    overridden: changes.filter((c) => c.kind === 'override'),
  };
}

/** Convenience: raw file text layers -> merged result. */
function mergeSources(sources, options = {}) {
  const layers = sources.map((source) => ({
    name: source.name,
    result: parse(source.text, { filename: source.name, format: source.format }),
  }));
  return merge(layers, options);
}

/** Merge plain key/value layers (used for `--env K=V`). */
function mergeValues(valuesList, options = {}) {
  const layers = valuesList.map((values, index) => ({
    name: options.names ? options.names[index] : `layer${index + 1}`,
    values,
  }));
  return merge(layers, options);
}

module.exports = { merge, mergeSources, mergeValues, toEntries, toObject };