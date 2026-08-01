'use strict';

const { assess, classifyLine, readContext } = require('./classify');
const { decide } = require('./hook');
const { expand, splitCommands, toArgv } = require('./parse');
const { RULES, LOCAL, MACHINE, REMOTE } = require('./rules');

module.exports = {
  assess,
  classifyLine,
  readContext,
  decide,
  expand,
  splitCommands,
  toArgv,
  RULES,
  LOCAL,
  MACHINE,
  REMOTE,
};
