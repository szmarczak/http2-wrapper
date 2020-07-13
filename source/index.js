'use strict';
const http2 = require('http2');
const agent = require('./agent');
const ClientRequest = require('./client-request');
const IncomingMessage = require('./incoming-message');
const auto = require('./auto');
const {
	H1overH2,
	H1SoverH2
} = require('./proxies/h1-over-h2');
const H2overH2 = require('./proxies/h2-over-h2');
const H2overH1 = require('./proxies/h2-over-h1');
const H2toH2 = require('./proxies/h2-to-h2');
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
	...agent,
	request,
	get,
	auto,
	proxies: {
		H1overH2,
		H1SoverH2,
		H2overH2,
		H2overH1,
		H2toH2
	},
	validateHeaderName,
	validateHeaderValue
};
