'use strict';
const http2 = require('http2');
const agent = require('./agent');
const ClientRequest = require('./client-request');
const IncomingMessage = require('./incoming-message');
const auto = require('./auto');
const {
	HttpOverHttp2,
	HttpsOverHttp2
} = require('./proxies/h1-over-h2');
const Http2OverHttp2 = require('./proxies/h2-over-h2');
const {
	Http2OverHttp,
	Http2OverHttps
} = require('./proxies/h2-over-h1');
const validateHeaderName = require('./utils/validate-header-name');
const validateHeaderValue = require('./utils/validate-header-value');

const request = (url, options, callback) => {
	return new ClientRequest(url, options, callback);
};

const get = (url, options, callback) => {
	// eslint-disable-next-line unicorn/prevent-abbreviations
	const req = new ClientRequest(url, options, callback);
	req.end();

	return req;
};

const [major, minor] = process.versions.node.split('.').map(x => Number(x));

/* istanbul ignore next: fallback to native http2 module on Node.js <15.5 */
const isStable = major === 15 ? minor >= 6 : major > 15;

/* istanbul ignore next: fallback to native http2 module on Node.js <15.5 */
module.exports = isStable ? {
	...http2,
	ClientRequest,
	IncomingMessage,
	...agent,
	request,
	get,
	auto,
	proxies: {
		HttpOverHttp2,
		HttpsOverHttp2,
		Http2OverHttp2,
		Http2OverHttp,
		Http2OverHttps
	},
	validateHeaderName,
	validateHeaderValue
} : http2;
