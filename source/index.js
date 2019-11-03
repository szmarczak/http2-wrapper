'use strict';
const http2 = require('http2');
const agent = require('./agent');
const ClientRequest = require('./client-request');
const IncomingMessage = require('./incoming-message');
const auto = require('./auto');

const get = (url, options, callback) => {
	const req = ClientRequest.request(url, options, callback);
	req.end();

	return req;
};

module.exports = {
	...http2,
	...agent,
	auto,
	request: ClientRequest.request,
	get,
	ClientRequest,
	IncomingMessage
};
