'use strict';
const isCompatible = require('./utils/is-compatible');
const auto = require('./auto');

if (isCompatible) {
	const http2 = require('http2');
	const agent = require('./agent');
	const ClientRequest = require('./client-request');
	const IncomingMessage = require('./incoming-message');

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
} else {
	module.exports = {auto};
}
