'use strict';
const stream = require('stream');
const tls = require('tls');

// Don't tell me I can't do this when I can.
const JSStreamSocket = (new tls.TLSSocket(new stream.PassThrough()))._handle._parentWrap.constructor;

module.exports = JSStreamSocket;
