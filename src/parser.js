'use strict';

const { UsageError } = require('./errors.js');
const { assignKey } = require('./keysafe.js');

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

/**
 * Decode the escape sequences a `.properties` file may contain.
 *
 * Transcribed from java.util.Properties#loadConvert: `\\ \t \n \r \f` and
 * `\uXXXX` are the escapes, and ANY other `\c` stands for `c` itself --
 * that is how `\#`, `\=`, `\!` and `\:` keep a separator or a comment
 * character literal. A trailing lone backslash is data, not an error.
 */
function unescapeProperties(text) {
  if (!text.includes('\\')) return text;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) {
      out += '\\';
      break;
    }
    if (next === 't') { out += '\t'; i += 1; continue; }
    if (next === 'n') { out += '\n'; i += 1; continue; }
    if (next === 'r') { out += '\r'; i += 1; continue; }
    if (next === 'f') { out += '\f'; i += 1; continue; }
    if (next === 'u') {
      const hex = text.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
        continue;
      }
      // A malformed \uXXXX is left alone rather than silently losing a byte.
      out += next;
      i += 1;
      continue;
    }
    out += next;
    i += 1;
  }
  return out;
}

/** Is this line the first entry of a `.properties` logical line? */
function isPropertiesCommentStart(text, at) {
  const ch = text[at];
  // java.util.Properties#LineReader treats only `#` and `!` as comments, and
  // only in column zero of the logical line. `;` is ordinary data there.
  return ch === '#' || ch === '!';
}

/**
 * Assemble the `.properties` LOGICAL line that starts at absolute index
 * `from`, following java.util.Properties#LineReader#readLine to the letter.
 *
 * The four behaviours that matter, each of which a "looks about right"
 * implementation gets wrong:
 *
 *   1. A physical line ending in an ODD number of backslashes continues: the
 *      backslash is dropped, the next line's leading space/tab/FF is dropped,
 *      and the halves are joined. An EVEN number does not continue.
 *   2. The blank-line test happens BEFORE the backslash is popped, and the
 *      final "return precedingBackslash ? len - 1 : len" yields 0 -- not -1 --
 *      for a file whose last line is a lone `\`. Java treats limit 0 as a real
 *      (empty) line, so that file contains the entry {"": ""}. This function
 *      returns an empty text rather than null in exactly that case; every other
 *      EOF-with-nothing-buffered returns null.
 *   3. Conversely, a line that is nothing but a backslash followed by a
 *      newline IS blank, because the newline is reached while len == 1 and the
 *      `len == 0` reset does not fire; the continuation then consumes the next
 *      line. So "\\\n" alone produces nothing at all.
 *   4. A blank line in the middle of a continuation is skipped and the
 *      continuation keeps going.
 *
 * Returns the joined text and the index just past the last physical line
 * consumed.
 */
function readLogicalLine(src, from) {
  let i = from;
  let buf = '';
  let skipWhiteSpace = true;
  let appendedLineBegin = false;
  let precedingBackslash = false;

  for (;;) {
    if (i >= src.length) {
      if (buf === '') {
        // Java: `if (len == 0) return -1;` -- but that branch is only reached
        // when nothing at all was buffered, i.e. every character consumed so
        // far was skipped whitespace, a comment or a newline. Reaching it with
        // buf empty and precedingBackslash true means the last physical line
        // was a lone `\`; Java then returns 0, a real empty line. Falling out
        // of the loop with buf === '' and precedingBackslash true is exactly
        // that case.
        if (precedingBackslash) return { text: '', resume: src.length };
        return null;
      }
      return { text: precedingBackslash ? buf.slice(0, -1) : buf, resume: src.length };
    }
    const c = src[i];
    i += 1;

    if (skipWhiteSpace) {
      if (c === ' ' || c === '\t' || c === '\f') continue;
      if (!appendedLineBegin && (c === '\r' || c === '\n')) continue;
      skipWhiteSpace = false;
      appendedLineBegin = false;
    }

    // A `#` or `!` in column zero of the logical line starts a comment, and
    // swallows the rest of the physical line. Note `;` is NOT one of them.
    if (buf === '' && (c === '#' || c === '!')) {
      while (i < src.length) {
        const d = src[i];
        i += 1;
        if (d === '\r' || d === '\n') break;
      }
      skipWhiteSpace = true;
      continue;
    }

    if (c !== '\n' && c !== '\r') {
      buf += c;
      precedingBackslash = c === '\\' ? !precedingBackslash : false;
      continue;
    }

    // Reached EOL.
    if (buf === '') {
      skipWhiteSpace = true;
      continue;
    }
    if (precedingBackslash) {
      // The backslash is not part of the line; keep reading.
      buf = buf.slice(0, -1);
      skipWhiteSpace = true;
      appendedLineBegin = true;
      precedingBackslash = false;
      if (c === '\r' && i < src.length && src[i] === '\n') i += 1;
      continue;
    }
    return { text: buf, resume: i };
  }
}

/**
 * Parse one `.properties` logical line, already assembled by readLogicalLine.
 *
 * A literal transcription of java.util.Properties#load0. The key ends at the
 * first UNESCAPED `=`, `:`, space, tab or form feed. That character is only a
 * REAL separator if a `=` or `:` turns up after the run of whitespace -- so
 * `KEY value` splits into `KEY`/`value`, exactly as Properties does, and a
 * line ending in whitespace keeps that whitespace as part of its key.
 *
 * Whitespace around the separator is discarded; whitespace INSIDE the value
 * is kept. Note there is no "bare key, empty value" case to special-case:
 * load0 computes `valueStart` for whitespace-separated lines too, so the
 * value is simply whatever follows the separator or the whitespace run.
 *
 * The comment test is NOT repeated here: readLogicalLine already consumed any
 * `#`/`!` comment line whole, so `rest` reaching this point is data.
 *
 * An EMPTY `rest` is the one entry LineReader returns without consuming
 * anything (see readLogicalLine's EOF branch), and it is a real entry: the file
 * consisting of a single `\` reads back as {"": ""}. Blank lines never arrive
 * here -- readLogicalLine skips those itself.
 *
 * No key-shape check is applied, deliberately. java.util.Properties accepts
 * almost any character in a key -- quotes, spaces, `=`, `;`, tab, form feed,
 * even the empty key that `=value` produces -- and escapes exactly the
 * awkward ones on the way out. envjson keeps the stricter
 * `[A-Za-z_][A-Za-z0-9_.-]*` rule for `.env`/`.ini`, where a dot-separated name
 * is a meaningful path. A `.properties` key is opaque, so rejecting names here
 * would make envjson unable to read back its own `--format properties` output.
 */
function scanPropertiesEntry(logical, cursor) {
  const rest = logical.slice(cursor);
  if (rest === '') return { key: '', value: '' };

  let keyLen = 0;
  let valueStart = rest.length;
  let hasSep = false;
  let precedingBackslash = false;

  // Pass 1: find where the key ends, remembering escape parity.
  while (keyLen < rest.length) {
    const c = rest[keyLen];
    if (!precedingBackslash) {
      if (c === '=' || c === ':') {
        valueStart = keyLen + 1;
        hasSep = true;
        break;
      }
      if (c === ' ' || c === '\t' || c === '\f') {
        valueStart = keyLen + 1;
        break;
      }
    }
    precedingBackslash = c === '\\' ? !precedingBackslash : false;
    keyLen += 1;
  }

  // Pass 2: skip the whitespace, and let a `=`/`:` after it become the real
  // separator.
  while (valueStart < rest.length) {
    const c = rest[valueStart];
    if (c !== ' ' && c !== '\t' && c !== '\f') {
      if (!hasSep && (c === '=' || c === ':')) {
        hasSep = true;
      } else {
        break;
      }
    }
    valueStart += 1;
  }

  // An empty key is LEGAL in .properties: `=value` is the entry {"": "value"}.
  // Refusing it would reject files java.util.Properties reads without complaint.
  const key = unescapeProperties(rest.slice(0, keyLen));
  // UNCONDITIONAL, matching load0 line 458. `hasSep` is written at the two
  // branches above and read once inside pass 2, but in the JDK it never gates
  // the result: `valueStart` is already correct either way. A previous version
  // of this function returned '' unless hasSep was set, which silently threw
  // away the value of every bare `KEY value` line -- 2443 of 2443 mismatched
  // fuzz documents, every one of them this bug.
  const value = unescapeProperties(rest.slice(valueStart));
  return { key, value };
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

    // --- .properties runs on logical lines, not physical ones -----------
    // A comment, a blank line and a backslash continuation can all span more
    // than one physical line, so the whole reading loop has to happen before
    // any statement is classified. The dotenv/ini dialects have no such
    // notion and keep the per-physical-line path below.
    if (format === 'properties') {
      const logical = readLogicalLine(src, stmtStart);
      if (logical === null) break;
      pos = logical.resume;
      line = startLine + countNewlines(src.slice(stmtStart, pos));
      const stmt = scanPropertiesEntry(logical.text, 0, startLine);
      if (!stmt) continue;
      const previousLine = seen.get(stmt.key);
      if (previousLine !== undefined) {
        duplicates.push({ key: stmt.key, line: startLine, previousLine });
      }
      seen.set(stmt.key, startLine);
      entries.push({
        key: stmt.key,
        value: stmt.value,
        line: startLine,
        quoted: null,
        exported: false,
        expression: stmt.value,
        format,
        section: null,
        raw: src.slice(stmtStart, pos).replace(/\n+$/, ''),
      });
      continue;
    }

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
    for (const entry of result.entries) assignKey(out, entry.key, entry.value);
  } else {
    for (const [k, v] of Object.entries(result || {})) assignKey(out, k, v);
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