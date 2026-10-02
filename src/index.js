'use strict';

const { DEFAULTS, FORMATS, MASK, SECRET_PATTERNS, EXIT } = require('./defaults.js');
const { EnvjsonError, UsageError, InterpolationError } = require('./errors.js');
const parser = require('./parser.js');
const interpolate = require('./interpolate.js');
const mergeMod = require('./merge.js');
const redact = require('./redact.js');

module.exports = {
  DEFAULTS,
  FORMATS,
  MASK,
  SECRET_PATTERNS,
  EXIT,
  EnvjsonError,
  UsageError,
  InterpolationError,
  parse: parser.parse,
  toObject: parser.toObject,
  detectFormat: parser.detectFormat,
  isPureReference: parser.isPureReference,
  expand: interpolate.expand,
  expandObject: interpolate.expandObject,
  merge: mergeMod.merge,
  mergeSources: mergeMod.mergeSources,
  mergeValues: mergeMod.mergeValues,
  redactObject: redact.redactObject,
  isSecretKey: redact.isSecretKey,
  load: (text, options) => parser.toObject(parser.parse(text, options)),
};