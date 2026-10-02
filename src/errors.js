'use strict';

/** Every error this package raises on purpose is an EnvjsonError. */
class EnvjsonError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EnvjsonError';
    this.code = code || 'ENVJSON_ERROR';
  }
}

/** Bad flags, bad values, unreadable files: all exit 2. */
class UsageError extends EnvjsonError {
  constructor(message) {
    super(message, 'ENVJSON_USAGE');
    this.name = 'UsageError';
  }
}

/** A ${VAR:?message} or ${VAR?message} expansion demanded a value that is missing. */
class InterpolationError extends EnvjsonError {
  constructor(message) {
    super(message, 'ENVJSON_INTERPOLATION');
    this.name = 'InterpolationError';
  }
}

module.exports = { EnvjsonError, UsageError, InterpolationError };