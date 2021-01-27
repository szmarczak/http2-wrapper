'use strict';
const http2 = require('http2');
const {
	Agent,
	globalAgent
} = require('./agent');
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

module.exports = {
	...http2,
	ClientRequest,
	IncomingMessage,
	Agent,
	globalAgent,
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
};
