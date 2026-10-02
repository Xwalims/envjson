'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DEFAULTS, FORMATS, EXIT } = require('./defaults.js');
const { UsageError, InterpolationError, EnvjsonError } = require('./errors.js');
const { parse } = require('./parser.js');
const { merge } = require('./merge.js');
const { redactObject } = require('./redact.js');

const HELP = `envjson - read .env / .ini / .properties files, merge layers, emit JSON

Usage:
  envjson [files...] [options]

Options:
  --env K=V           Add a key/value layer (repeatable, highest precedence)
  --format FMT        json | ndjson | jsonl | ini | properties  (default: json)
  --json              Shorthand for --format json
  --jsonl, --ndjson   Shorthand for --format ndjson
  --redact            Mask values whose key looks secret
  --redact-keys a,b   Extra key names to treat as secret
  --dry-run           Resolve everything, print nothing
  --stats             Print a summary to stderr
  --explain           Print per-key provenance to stderr
  --check             Exit 3 when the merged result differs from the first file
  --fail-on-change    Exit 1 when any layer overrides an earlier value
  -o, --output FILE   Write the output to FILE instead of stdout
  -h, --help          Show this help
  -v, --version       Show the version

Exit codes:
  0  ok
  1  --fail-on-change and something was overridden
  2  usage or IO error
  3  --check found drift from the first file
`;

function splitList(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Parse argv into an options object. Defaults come only from DEFAULTS.
 * Throws UsageError on anything malformed.
 */
function parseArgs(argv) {
  // Start from the single frozen defaults object, copied so callers can mutate.
  const options = Object.assign({}, DEFAULTS);
  options.files = [];
  options.env = [];
  options.redactKeys = [];
  options.help = false;
  options.version = false;
  options.errors = [];

  let i = 0;
  let noMoreFlags = false;

  const needValue = (flag, value) => {
    if (value === undefined) throw new UsageError(`${flag} requires a value`);
  };

  while (i < argv.length) {
    const arg = argv[i];
    if (noMoreFlags || arg === '-' || !arg.startsWith('-')) {
      options.files.push(arg);
      i += 1;
      continue;
    }
    if (arg === '--') {
      noMoreFlags = true;
      i += 1;
      continue;
    }
    const eq = arg.indexOf('=');
    const hasInline = eq !== -1;
    const flag = hasInline ? arg.slice(0, eq) : arg;
    const inline = hasInline ? arg.slice(eq + 1) : undefined;
    const take = (name) => {
      if (hasInline) return inline;
      i += 1;
      return argv[i];
    };

    switch (flag) {
      case '-h':
      case '--help':
        options.help = true;
        i += 1;
        break;
      case '-v':
      case '--version':
        options.version = true;
        i += 1;
        break;
      case '--json':
        options.format = 'json';
        i += 1;
        break;
      case '--jsonl':
      case '--ndjson':
        options.format = 'ndjson';
        i += 1;
        break;
      case '--redact':
        options.redact = true;
        i += 1;
        break;
      case '--redact-keys':
        needValue(flag, take(flag));
        options.redactKeys.push(...splitList(argv[i]));
        i += 1;
        break;
      case '--format':
      case '-f': {
        const value = take(flag);
        needValue(flag, value);
        if (!FORMATS.includes(value)) {
          throw new UsageError(`--format must be one of ${FORMATS.join(', ')} (got "${value}")`);
        }
        options.format = value;
        i += 1;
        break;
      }
      case '--env':
      case '-e': {
        const value = take(flag);
        needValue(flag, value);
        const eq2 = value.indexOf('=');
        if (eq2 <= 0) throw new UsageError(`--env expects KEY=VALUE (got "${value}")`);
        options.env.push([value.slice(0, eq2), value.slice(eq2 + 1)]);
        i += 1;
        break;
      }
      case '--dry-run':
        options.dryRun = true;
        i += 1;
        break;
      case '--stats':
        options.stats = true;
        i += 1;
        break;
      case '--explain':
        options.explain = true;
        i += 1;
        break;
      case '--check':
        options.check = true;
        i += 1;
        break;
      case '--fail-on-change':
        options.failOnChange = true;
        i += 1;
        break;
      case '--output':
      case '-o': {
        const value = take(flag);
        needValue(flag, value);
        options.out = value;
        i += 1;
        break;
      }
      default:
        throw new UsageError(`unknown option "${arg}"`);
    }
  }
  return options;
}

/** Serialize the merged object into the requested shape. */
function format(object, formatName) {
  switch (formatName) {
    case 'json':
      return JSON.stringify(object, null, DEFAULTS.indent) + '\n';
    case 'ndjson':
    case 'jsonl': {
      const lines = Object.entries(object).map(
        ([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`
      );
      return lines.length ? lines.join('\n') + '\n' : '';
    }
    case 'ini':
      return formatIni(object, true);
    case 'properties':
      return formatProperties(object);
    default:
      throw new UsageError(`unknown format "${formatName}"`);
  }
}

/** ini output is round-trippable: quote anything containing a `#`, `;` or newline. */
function iniEscape(value) {
  const str = String(value);
  if (str === '') return '""';
  if (/[#;\r\n]/.test(str) || /^[ \t]|[ \t]$/.test(str)) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return str;
}

/** Group `app.db.host` into `[app.db]` sections. Keys without a dot stay top-level. */
function formatIni(object, _withSections) {
  const top = [];
  const sections = new Map();
  for (const [key, value] of Object.entries(object)) {
    const dot = key.lastIndexOf('.');
    if (dot <= 0) {
      top.push([key, value]);
      continue;
    }
    const section = key.slice(0, dot);
    const leaf = key.slice(dot + 1);
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push([leaf, value]);
  }
  let out = '';
  for (const [key, value] of top) out += `${key} = ${iniEscape(value)}\n`;
  for (const [section, entries] of sections) {
    if (out !== '') out += '\n';
    out += `[${section}]\n`;
    for (const [key, value] of entries) out += `${key} = ${iniEscape(value)}\n`;
  }
  return out;
}

function propertiesEscape(value) {
  const str = String(value);
  if (str === '') return '';
  if (/[#!:\\=\s]/.test(str) || /^[ \t]|[ \t]$/.test(str) || /^[\s]/.test(str)) {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/([#!:=])/g, '\\$1');
  }
  return str;
}

function formatProperties(object) {
  let out = '';
  for (const [key, value] of Object.entries(object)) {
    out += `${key}=${propertiesEscape(value)}\n`;
  }
  return out;
}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${file}: ${err.code || err.message}`);
  }
}

/** Real main entry. Returns the process exit code; never calls process.exit. */
function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const write = (stream, text) => {
    if (text !== '') stream.write(text);
  };

  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    stderr.write(`envjson: ${err.message}\n`);
    stderr.write('Try "envjson --help" for usage.\n');
    return EXIT.USAGE;
  }

  if (options.help) {
    write(stdout, HELP);
    return EXIT.OK;
  }
  if (options.version) {
    const pkg = require('../package.json');
    write(stdout, `${pkg.name} ${pkg.version}\n`);
    return EXIT.OK;
  }

  if (options.files.length === 0 && options.env.length === 0) {
    stderr.write('envjson: no input files given (and no --env)\n');
    stderr.write('Try "envjson --help" for usage.\n');
    return EXIT.USAGE;
  }

  // ---- build layers -------------------------------------------------
  const layers = [];
  try {
    for (const file of options.files) {
      const text = readFile(file);
      layers.push({ name: path.basename(file), result: parse(text, { filename: file }) });
    }
  } catch (err) {
    stderr.write(`envjson: ${err.message}\n`);
    return EXIT.USAGE;
  }
  if (options.env.length) {
    layers.push({ name: '--env', values: options.env });
  }

  // ---- merge + interpolate ------------------------------------------
  let merged;
  try {
    merged = merge(layers);
  } catch (err) {
    stderr.write(`envjson: ${err.message}\n`);
    return EXIT.USAGE;
  }

  if (merged.errors.length) {
    for (const e of merged.errors) stderr.write(`envjson: ${e.key}: ${e.message}\n`);
    return EXIT.USAGE;
  }

  let object = merged.object;

  // ---- redact -------------------------------------------------------
  let redactedKeys = [];
  if (options.redact || options.redactKeys.length) {
    const r = redactObject(object, { keys: options.redactKeys });
    object = r.object;
    redactedKeys = r.redactedKeys;
  }

  // ---- side channels (stderr only, so stdout stays pipeable) ---------
  if (options.explain) {
    const rows = Object.keys(object)
      .sort()
      .map((key) => {
        const p = merged.provenance[key];
        const where = p ? `${p.file}${p.line ? `:${p.line}` : ''}` : '?';
        return `  ${key} = ${JSON.stringify(object[key])}  <- ${where}`;
      });
    write(stderr, `explain:\n${rows.join('\n')}\n`);
  }

  if (options.stats) {
    const layersUsed = layers.map((l) => l.name).join(', ') || '(none)';
    write(
      stderr,
      `stats: layers=${layers.length} [${layersUsed}] keys=${Object.keys(object).length} ` +
        `overrides=${merged.overridden.length} duplicates=${merged.duplicates.length} ` +
        `redacted=${redactedKeys.length}\n`
    );
  }

  // ---- output --------------------------------------------------------
  if (!options.dryRun) {
    const text = format(object, options.format);
    if (options.out) {
      try {
        fs.writeFileSync(options.out, text);
      } catch (err) {
        stderr.write(`envjson: cannot write ${options.out}: ${err.code || err.message}\n`);
        return EXIT.USAGE;
      }
    } else {
      write(stdout, text);
    }
  }

  // ---- exit codes ----------------------------------------------------
  if (options.check) {
    // Drift = the merged result differs from the FIRST file on its own.
    // The baseline is built with merge() too, so it goes through exactly the
    // same quote and self-reference rules; comparing raw text would report a
    // false drift for every single-quoted value.
    const first = layers.find((l) => l.result);
    if (first) {
      const baseline = merge([first], { useProcessEnv: true }).object;
      if (!sameShape(baseline, merged.object)) {
        stderr.write('envjson: --check found drift from the first file\n');
        return EXIT.DRIFT;
      }
    }
  }

  if (options.failOnChange && merged.overridden.length > 0) {
    return EXIT.CHANGED;
  }

  return EXIT.OK;
}

/**
 * Order-independent structural equality for flat string maps. Sorting the keys
 * means a merge that adds a key at the end is not reported as drift.
 */
function sameShape(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return false;
    if (a[ka[i]] !== b[ka[i]]) return false;
  }
  return true;
}

module.exports = { main, parseArgs, format, formatIni, formatProperties, HELP, EXIT };