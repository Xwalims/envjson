#!/usr/bin/env node
'use strict';

// The exit-code assignment is load-bearing: without it every failure exits 0.
process.exitCode = require('../src/cli.js').main(process.argv.slice(2));