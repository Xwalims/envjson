# envjson

Read `.env` / `.ini` / `.properties` files, merge layers, emit JSON.

Zero dependencies. Node >= 20. Built on `node:test`, so `npm test` needs nothing installed.

```bash
node bin/envjson.js .env
```

<!-- hero -->

[![CI](https://github.com/envjson/actions/workflows/ci.yml/badge.svg)](https://github.com/envjson/actions/workflows/ci.yml)
![node 20+](https://img.shields.io/badge/node-20+-brightgreen)
![MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![dependencies](https://img.shields.io/badge/dependencies-none-2f6f4f)

## Contents

- [Why this exists](#why-this-exists)
- [Install](#install)
- [Quick start](#quick-start)
- [Output formats](#output-formats)
- [Exit codes](#exit-codes)
- [License](#license)

<!-- /hero -->

## Why this exists

Most dotenv readers are wrong in small ways that only bite in production: they
eat the `#` in a hex colour, they treat a single-quoted `$` as a variable, they
drop a layer's value because an override file mentioned it. envjson documents
every rule it follows and tests each one.

## Install

```bash
git clone <this repo> && cd envjson
node bin/envjson.js --help
```

Or link it onto your `PATH`:

```bash
npm link     # provides the `envjson` command
```

## Quick start

Given a `.env`:

```dotenv
# app config
export APP_NAME=envjson
export APP_ENV=development

PORT=8080
DEBUG=true
API_TOKEN=abc123xyz
DB_PASSWORD=letmein
WELCOME="Hello, ${APP_NAME}!"
LITERAL='not ${APP_NAME}'
TEMPLATE="-----BEGIN KEY-----
line-one
-----END KEY-----"
```

`envjson .env` prints:

```json
{
  "APP_NAME": "envjson",
  "APP_ENV": "development",
  "PORT": "8080",
  "DEBUG": "true",
  "API_TOKEN": "abc123xyz",
  "DB_PASSWORD": "letmein",
  "WELCOME": "Hello, envjson!",
  "LITERAL": "not ${APP_NAME}",
  "TEMPLATE": "-----BEGIN KEY-----\nline-one\n-----END KEY-----"
}
```

Note the last three lines. `WELCOME` was interpolated because it was
double-quoted. `LITERAL` was **not**, because it was single-quoted.
`TEMPLATE` spans several physical lines.

## Merging layers

Later files override earlier ones. Add a `.env.production`:

```dotenv
APP_ENV=production
PORT=${PORT}
LOG_LEVEL=${LOG_LEVEL:-info}
```

`envjson .env .env.production --format ndjson`:

```
"APP_NAME": "envjson"
"APP_ENV": "production"
"PORT": "8080"
"DEBUG": "true"
"API_TOKEN": "abc123xyz"
"DB_PASSWORD": "letmein"
"WELCOME": "Hello, envjson!"
"LITERAL": "not ${APP_NAME}"
"TEMPLATE": "-----BEGIN KEY-----\nline-one\n-----END KEY-----"
"LOG_LEVEL": "info"
```

`APP_ENV` was overridden. `PORT=${PORT}` **kept** 8080 rather than blanking it
(see the pure-reference rule below). `LOG_LEVEL` did not exist yet, so
`${LOG_LEVEL:-info}` used its default.

## The pure-reference rule

This is the one rule worth reading twice.

> A layer value that is **nothing but** `${VAR}` — no default, no `:-`, no `?` —
> is treated as a *request to resolve* `VAR`, not as an override. If the key
> already has a value from an earlier layer, that earlier value is kept.

So `PORT=${PORT}` in an override file means "keep whatever the base file said",
which is the entire point of an override layer. Every other shape is a real
override:

| Layer value         | Pure ref? | Behaviour                                        |
| ------------------- | --------- | ------------------------------------------------ |
| `PORT=${PORT}`      | yes       | keeps the inherited value                        |
| `PORT=${PORT:-8080}`| no        | override; reads the inherited value, else `8080` |
| `PORT='${PORT}'`    | no        | override; single quotes are literal              |
| `PORT=x${PORT}`     | no        | override                                         |

## Parsing rules

**Splitting.** A statement splits on the **first `=` only**. `URL=a=b` yields
`a=b`. A key with no `=` at all is a bare key with an empty value.

**Quoting.**

| Form         | Escapes           | `${VAR}` expanded |
| ------------ | ----------------- | ----------------- |
| `'single'`   | none, fully literal | no              |
| `"double"`   | `\\ \n \t \r \"`   | yes               |
| `unquoted`   | none              | yes               |

A backslash inside single quotes is ordinary text and **cannot** escape the
closing quote. An unknown escape in a double-quoted value keeps both characters
(`"\q"` is `\q`).

**Comments.** A `#` or `;` starts a comment when it is at the start of a line
or is preceded by whitespace. In an unquoted value, `COLOR=#ff8800` is the
literal string `#ff8800`, and `A=value  # note` is `value`.

**Multiline.** A quoted value may span lines; the closing quote ends it and the
rest of that line may only be a comment.

**Other.** A leading BOM is stripped. CRLF and CR are normalized to LF. An
optional `export ` prefix is accepted, but `exported_key` and `export=1` are
ordinary keys. A `;` comment only counts as a comment when it starts a line or
follows whitespace. Duplicate keys: **last one wins**, and the duplicates are
reported in `--stats`.

## Interpolation forms

| Form            | Meaning                                        |
| --------------- | ---------------------------------------------- |
| `$VAR`          | bare name; unset gives an empty string          |
| `${VAR}`        | braced; unset gives an empty string             |
| `${VAR:-def}`   | `def` when unset **or empty**                   |
| `${VAR-def}`    | `def` when unset (empty counts as set)          |
| `${VAR:?msg}`   | error when unset **or empty**                   |
| `${VAR?msg}`    | error when unset                                |
| `\$`            | a literal dollar sign                           |

Lookup order is: the merged object, then `process.env`. A reference resolves
lazily, so it may point at a key defined further down the file.

**Self-references terminate.** A template that names the key it defines reads
that key's *previous* value, exactly like a shell assignment. `PORT=${PORT:-3000}`
over an inherited `PORT=8080` gives `8080`; over nothing it gives `3000`. There
is no infinite loop and no stack overflow. An *indirect* cycle (`A=x${B}` /
`B=y${A}`) is detected by the resolution chain and reported as an error; the
offending keys are dropped from the output while their siblings survive.

## Redaction

`--redact` masks the value of any key containing `TOKEN`, `SECRET`, `KEY`,
`PASSWORD`, `PASS`, `CREDENTIAL`, `AUTH` or `PRIVATE` (case-insensitive,
anywhere in the name). Everything else stays readable.

```bash
envjson .env --redact
```

```json
{
  "APP_NAME": "envjson",
  "APP_ENV": "development",
  "PORT": "8080",
  "DEBUG": "true",
  "API_TOKEN": "***REDACTED***",
  "DB_PASSWORD": "***REDACTED***",
  "WELCOME": "Hello, envjson!",
  "LITERAL": "not ${APP_NAME}",
  "TEMPLATE": "-----BEGIN KEY-----\nline-one\n-----END KEY-----"
}
```

Add your own names with `--redact-keys session,csrf`. An empty value stays
empty rather than becoming a mask — masking `""` would invent a secret.

## Output formats

`--format json` (default), `ndjson`/`jsonl`, `ini`, `properties`.

```bash
envjson --env A=1 --env 'B=a b' --env 'C=n=1' --format properties
```

```
A=1
B=a b
C=n\=1
```

```bash
envjson --env TOP=1 --env 'server.host=localhost' --env 'server.port=8080' --format ini
```

```
TOP = 1

[server]
host = localhost
port = 8080
```

Dotted keys become `[section]` + leaf. `ini` output quotes any value containing
`#`, `;` or a newline, so it round-trips back through the parser.

## Options

```
envjson [files...] [options]

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
```

`--stats`, `--explain` and every diagnostic go to **stderr**, so stdout stays
pipeable into `jq` no matter how many of them you combine.

```bash
envjson .env .env.production --explain --stats -o merged.json
```

```
explain:
  API_TOKEN = "abc123xyz"  <- .env:7
  APP_ENV = "production"  <- .env.production:1
  APP_NAME = "envjson"  <- .env:2
  DB_PASSWORD = "letmein"  <- .env:8
  DEBUG = "true"  <- .env:6
  LITERAL = "not ${APP_NAME}"  <- .env:10
  LOG_LEVEL = "info"  <- .env.production:3
  PORT = "8080"  <- .env:5
  TEMPLATE = "-----BEGIN KEY-----\nline-one\n-----END KEY-----"  <- .env:11
  WELCOME = "Hello, envjson!"  <- .env:9
stats: layers=2 [.env, .env.production] keys=10 overrides=1 duplicates=0 redacted=0
```

## Exit codes

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| `0`  | ok                                                        |
| `1`  | `--fail-on-change` and some layer overrode an earlier value |
| `2`  | usage or IO error (bad flag, missing file, `${VAR:?}` failed) |
| `3`  | `--check` found drift from the first file                |

`--check` compares the merged result against the first file *on its own*, run
through the same merge pipeline so quote rules cannot produce a false drift.
Key order is ignored; only real value differences count.

`--fail-on-change` fires on genuine overrides only. A layer whose only change is
the pure-reference rule is a *keep*, not an override, so it does not trip the flag.

## ini and .properties input

The parser picks a dialect from the filename: `.env` and `.env.*` are dotenv;
`.ini`, `.conf` and `.cfg` are ini; `.properties` is properties. With no
filename hint it sniffs the content for a `[section]` header. INI section
headers prefix the keys inside them:

```ini
[server]
host = localhost
port = 8080
```

becomes `server.host` and `server.port`. Pass `format: 'properties'` (or a
`.properties` filename) to keep dots in the key name instead.

## API

```js
const { parse, mergeSources, expand, redactObject } = require('./src/index.js');

const result = parse(text, { filename: '.env' });
result.entries;     // ordered, with .value .line .quoted .expression
result.duplicates;  // [{ key, line, previousLine }]

const merged = mergeSources([
  { name: '.env', text: baseText },
  { name: '.env.production', text: prodText },
]);
merged.object;      // the merged, fully resolved string map
merged.changes;     // [{ key, kind: 'add'|'override'|'kept'|'failed', ... }]
merged.overridden;  // just the overrides
merged.provenance;  // key -> { file, line }
```

`merge` commits raw text first and resolves once at the end, which is what makes
forward references work. Single-quoted values carry a `null` template and are
passed through untouched.

## Tests

```bash
node --test
```

```
ℹ tests 135
ℹ suites 0
ℹ pass 135
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## License

MIT — Copyright (c) 2026 Xwalims
