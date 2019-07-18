'use strict';

const version = process.versions.node.split('.');

module.exports = version[0] >= 10;
