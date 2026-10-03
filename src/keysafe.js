'use strict';

/**
 * Writing a key that happens to be `__proto__`.
 *
 * Every layer of this package builds plain objects keyed by env var names, and
 * `parent[key] = value` is the obvious way to fill one. For exactly one legal
 * key name that is wrong, and wrong QUIETLY:
 *
 *   `__proto__` is not a property of the prototype; it is an ACCESSOR defined
 *   on `Object.prototype`. Assigning to it runs the setter, which replaces the
 *   object's prototype instead of creating a key. So:
 *
 *     const o = {};
 *     o.__proto__ = 'x';        // setter ran, no own property created
 *     Object.keys(o)            // []
 *     JSON.stringify(o)         // {}
 *
 * The key is not "stored but hidden" -- it is gone. Nothing downstream can see
 * it: `hasOwnProperty` correctly says no, and `Object.entries` skips it. A .env
 * file containing `__proto__=polluted` therefore round-trips through the whole
 * tool and disappears from the JSON output with no warning at all.
 *
 * `Object.defineProperty` creates a real own data property, which is what
 * `JSON.parse('{"__proto__":1}')` does. That is the behaviour we want: the file
 * said there is a variable called `__proto__`, and a variable called
 * `__proto__` is what the output must contain.
 *
 * Every write path in the package goes through `assignKey` for this reason.
 * `constructor`, `toString`, `hasOwnProperty` and friends need nothing special:
 * those are plain data properties on the prototype, so assigning to them
 * creates an own property that shadows it, exactly as JSON.parse does.
 */

const PROTO = '__proto__';

/**
 * Assign `value` to `key` on `target`, as data even when key is `__proto__`.
 *
 * @param {object} target
 * @param {string} key
 * @param {unknown} value
 * @returns {object} target
 */
function assignKey(target, key, value) {
  if (key === PROTO) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return target;
  }
  target[key] = value;
  return target;
}

/** True when `target` carries `key` as its OWN property. */
function hasKey(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * Shallow copy that preserves a literal `__proto__` key.
 *
 * `Object.assign({}, source)` is NOT equivalent: it copies through [[Set]], so
 * the `__proto__` accessor fires and the key is lost from the copy. Copying
 * key by key with `assignKey` keeps it. Only needed when the copy is itself
 * read as a data map (a lookup scope); for counting keys `Object.keys` is fine.
 */
function copyOwn(source) {
  const out = {};
  for (const key of Object.keys(source)) assignKey(out, key, source[key]);
  return out;
}

module.exports = { PROTO, assignKey, hasKey, copyOwn };