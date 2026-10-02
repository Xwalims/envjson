'use strict';

const { UsageError } = require('./errors.js');

/** Dialects understood by the parser. */
const DIALECTS = Object.freeze(['dotenv', 'ini', 'properties']);

/** A key may contain dots and dashes (ini/properties need them); it may not start with either. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** `export ` / `export\t` but not `exported_key` or `export=1`. */
const EXPORT_RE = /^export[ \t]+/;

const COMMENT_RE = /^[#;]/;
const INLINE_COMMENT_RE = /[ \t]+[#;]/;
const SECTION_RE = /^[ \t]*\[([^\]\r\n]*)\][ \t]*$/;

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Normalize CRLF and lone CR to LF. Doing this once up front keeps the
 * multiline quoted-value rules simple and makes CRLF files parse identically
 * to LF ones.
 */
function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Decide which dialect to use. An explicit option always wins; otherwise the
 * filename decides; otherwise the content is sniffed (an INI section header
 * means ini, anything else means dotenv).
 */
function detectFormat(text, filename, explicit) {
  if (explicit) {
    if (!DIALECTS.includes(explicit)) {
      throw new UsageError(
        `unknown format "${explicit}" (expected ${DIALECTS.join(', ')})`
      );
    }
    return explicit;
  }
  if (filename) {
    const base = String(filename)
      .slice(Math.max(String(filename).lastIndexOf('/'), String(filename).lastIndexOf('\\')) + 1)
      .toLowerCase();
    if (base === '.env' || base.startsWith('.env.')) return 'dotenv';
    if (base.endsWith('.ini') || base.endsWith('.conf') || base.endsWith('.cfg')) return 'ini';
    if (base.endsWith('.properties')) return 'properties';
  }
  if (SECTION_RE.test(String(text)) || /^[ \t]*\[[^\]\n]+\][ \t]*$/m.test(String(text))) {
    return 'ini';
  }
  return 'dotenv';
}

/**
 * Read a quoted value whose opening quote is at absolute index `start` in `src`.
 * Returns { value, end, closed } where `end` is the index just past the
 * closing quote.
 *
 * Double quotes: `\\ \n \t \r \"` are unescaped, an unknown escape keeps both
 * characters, and a backslash always stops the next character from closing the
 * string. Single quotes are fully literal, so a backslash inside them is
 * ordinary text and does not escape the closing quote.
 */
function scanQuoted(src, start) {
  const quote = src[start];
  const double = quote === '"';
  let i = start + 1;
  let out = '';
  while (i < src.length) {
    const ch = src[i];
    if (double && ch === '\\') {
      const next = src[i + 1];
      if (next === undefined) {
        out += '\\';
        i += 1;
        continue;
      }
      if (next === 'n') { out += '\n'; i += 2; continue; }
      if (next === 't') { out += '\t'; i += 2; continue; }
      if (next === 'r') { out += '\r'; i += 2; continue; }
      if (next === '"') { out += '"'; i += 2; continue; }
      if (next === '\\') { out += '\\'; i += 2; continue; }
      out += '\\' + next;
      i += 2;
      continue;
    }
    if (ch === quote) return { value: out, end: i + 1, closed: true };
    out += ch;
    i += 1;
  }
  return { value: out, end: i, closed: false };
}

/** Index of the `}` matching the `{` at `open`, honouring nesting. */
function findClosingBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse env/ini/properties text into an ordered entry list.
 *
 * Entries keep file order and carry the raw right-hand side, which is what
 * `--explain` and the merge rules need. Use `toObject()` for the plain
 * key/value map (last duplicate wins).
 *
 * All scanning works on absolute indexes into the source, never on trimmed
 * substrings, so a multiline quoted value can extend the cursor across lines
 * without losing track of where the next statement starts.
 */
function parse(text, options = {}) {
  const rawInput = String(text);
  const format = detectFormat(rawInput, options.filename, options.format);
  const hadBom = rawInput.charCodeAt(0) === 0xfeff;
  const src = normalizeNewlines(stripBom(rawInput));
  const allowExport = format === 'dotenv';
  const allowSections = format === 'ini';

  const entries = [];
  const duplicates = [];
  const seen = new Map();

  let pos = 0;
  let line = 1;
  let section = null;

  while (pos < src.length) {
    const stmtStart = pos;
    const startLine = line;
    let lineEnd = src.indexOf('\n', stmtStart);
    if (lineEnd === -1) lineEnd = src.length;
    const rawLine = src.slice(stmtStart, lineEnd);

    // --- whole-line classification -----------------------------------
    const lead = rawLine.length - rawLine.trimStart().length;
    let cursor = stmtStart + lead;
    let head = src.slice(cursor, lineEnd);
    const trimmed = head.trim();

    if (trimmed === '' || COMMENT_RE.test(trimmed)) {
      pos = lineEnd + 1;
      line = startLine + countNewlines(src.slice(stmtStart, pos));
      continue;
    }

    // --- INI section header -------------------------------------------
    if (allowSections && SECTION_RE.test(head)) {
      section = SECTION_RE.exec(head)[1].trim();
      pos = lineEnd + 1;
      line = startLine + countNewlines(src.slice(stmtStart, pos));
      continue;
    }

    // --- optional `export ` prefix ------------------------------------
    let exported = false;
    if (allowExport && EXPORT_RE.test(head)) {
      exported = true;
      cursor += head.indexOf('export') + 'export'.length;
      const rest = src.slice(cursor, lineEnd);
      cursor += rest.length - rest.trimStart().length;
      head = src.slice(cursor, lineEnd);
    }

    // --- key: split on the FIRST '=' only -----------------------------
    const eqRel = head.indexOf('=');
    const keyRaw = (eqRel === -1 ? head : head.slice(0, eqRel)).trim();
    if (keyRaw === '') {
      throw new UsageError(`${startLine}: missing key before "="`);
    }
    const key = section && !keyRaw.includes('.') ? `${section}.${keyRaw}` : keyRaw;
    if (!KEY_RE.test(key)) {
      throw new UsageError(`${startLine}: invalid key "${keyRaw}"`);
    }

    let value = '';
    let quoted = null;
    let expression = null;
    let resume = lineEnd + 1;

    if (eqRel === -1) {
      // Bare key with no '=' at all: an empty value.
      value = '';
    } else {
      // Absolute index of the first character after '='.
      let vStart = cursor + eqRel + 1;
      while (vStart < lineEnd && (src[vStart] === ' ' || src[vStart] === '\t')) vStart += 1;
      const qChar = src[vStart];

      if (qChar === "'" || qChar === '"') {
        quoted = qChar === "'" ? 'single' : 'double';
        const scan = scanQuoted(src, vStart);
        if (!scan.closed) {
          throw new UsageError(
            `${startLine}: unterminated ${quoted} quoted value for ${keyRaw}`
          );
        }
        value = scan.value;
        // A multiline value ends on a LATER physical line, so the trailing
        // junk check and the resume point both follow scan.end, not lineEnd.
        const afterQuote = src.indexOf('\n', scan.end);
        const tailEnd = afterQuote === -1 ? src.length : afterQuote;
        const trailing = src.slice(scan.end, tailEnd).trim();
        if (trailing !== '' && !COMMENT_RE.test(trailing)) {
          throw new UsageError(
            `${startLine}: unexpected "${trailing}" after closing quote of ${keyRaw}`
          );
        }
        expression = quoted === 'double' ? value : null;
        resume = afterQuote === -1 ? src.length : afterQuote + 1;
      } else {
        // Unquoted: runs to EOL and is trimmed. " #" starts a comment,
        // "a#b" and a leading "#" do not.
        const rest = src.slice(vStart, lineEnd);
        const m = INLINE_COMMENT_RE.exec(rest);
        value = (m ? rest.slice(0, m.index) : rest).trim();
        expression = value;
      }
    }

    const previousLine = seen.get(key);
    if (previousLine !== undefined) {
      duplicates.push({ key, line: startLine, previousLine });
    }
    seen.set(key, startLine);

    entries.push({
      key,
      value,
      line: startLine,
      quoted,
      exported,
      expression,
      format,
      section,
      raw: src.slice(stmtStart, resume).replace(/\n+$/, ''),
    });

    pos = resume;
    line = startLine + countNewlines(src.slice(stmtStart, resume));
  }

  return { format, entries, duplicates, hadBom };
}

/** Last duplicate wins, matching the documented rule. */
function toObject(result) {
  const out = {};
  if (result && Array.isArray(result.entries)) {
    for (const entry of result.entries) out[entry.key] = entry.value;
  } else {
    for (const [k, v] of Object.entries(result || {})) out[k] = v;
  }
  return out;
}

function countNewlines(text) {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') n += 1;
  return n;
}

/** True when a value is nothing but one reference, e.g. "${PORT}". */
function isPureReference(value) {
  return (
    typeof value === 'string' &&
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim())
  );
}

module.exports = {
  parse,
  toObject,
  detectFormat,
  isPureReference,
  stripBom,
  normalizeNewlines,
  DIALECTS,
  SECTION_RE,
};