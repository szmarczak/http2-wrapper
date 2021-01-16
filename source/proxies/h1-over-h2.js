'use strict';
// See https://github.com/facebook/jest/issues/2549
// eslint-disable-next-line node/prefer-global/url
const {URL} = require('url');
const tls = require('tls');
const http = require('http');
const https = require('https');
const {globalAgent} = require('../agent');
const UnexpectedStatusCodeError = require('./unexpected-status-code-error');

const initialize = (self, {url, proxyOptions = {}}) => {
	self.origin = new URL(url);
	self.proxyOptions = {...proxyOptions, headers: {...proxyOptions.headers}};

	if (proxyOptions.raw === undefined) {
		self.proxyOptions.raw = true;
	} else if (typeof proxyOptions.raw !== 'boolean') {
		throw new TypeError(`Expected 'proxyOptions.raw' to be a boolean, got ${typeof proxyOptions.raw}`);
	}

	const {username, password} = self.origin;
	if (username || password) {
		const data = `${username}:${password}`;
		self.proxyOptions.headers['proxy-authorization'] = `Basic ${Buffer.from(data).toString('base64')}`;
	}
};

const createConnection = (self, options, callback) => {
	(async () => {
		try {
			const stream = await globalAgent.request(self.origin, self.proxyOptions, {
				':method': 'CONNECT',
				':authority': `${options.host}:${options.port}`,
				...self.proxyOptions.headers
			});

			stream.once('error', callback);
			stream.once('response', headers => {
				const statusCode = headers[':status'];

				if (statusCode !== 200) {
					callback(new UnexpectedStatusCodeError(statusCode));
				}

				if (self.proxyOptions.raw && self instanceof https.Agent) {
					const secureStream = tls.connect(stream, options);

					secureStream.once('close', () => {
						stream.destroy();
					});

					callback(null, secureStream);
				}

				callback(null, stream);
			});
		} catch (error) {
			callback(error);
		}
	})();
};

class HttpOverHttp2 extends http.Agent {
	constructor(args) {
		super(args.agentOptions);

		initialize(this, args);
	}

	createConnection(options, callback) {
		createConnection(this, options, callback);
	}
}

class HttpsOverHttp2 extends https.Agent {
	constructor(args) {
		super(args.agentOptions);

		initialize(this, args);
	}

	createConnection(options, callback) {
		createConnection(this, options, callback);
	}
}

module.exports = {
	HttpOverHttp2,
	HttpsOverHttp2
};
