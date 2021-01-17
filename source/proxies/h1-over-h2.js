'use strict';
const tls = require('tls');
const http = require('http');
const https = require('https');
const {globalAgent} = require('../agent');
const UnexpectedStatusCodeError = require('./unexpected-status-code-error');
const initialize = require('./initialize');
const getAuthorizationHeaders = require('./get-auth-headers');

const createConnection = (self, options, callback) => {
	void (async () => {
		try {
			const {proxyOptions} = self;
			const {url, headers, raw} = proxyOptions;

			const stream = await globalAgent.request(url, proxyOptions, {
				...getAuthorizationHeaders(self),
				...headers,
				':method': 'CONNECT',
				':authority': `${options.host}:${options.port}`
			});

			stream.once('error', callback);
			stream.once('response', headers => {
				const statusCode = headers[':status'];

				if (statusCode !== 200) {
					callback(new UnexpectedStatusCodeError(statusCode));
				}

				if (raw && self instanceof https.Agent) {
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
	constructor(options) {
		super(options);

		initialize(this, options.proxyOptions);
	}

	createConnection(options, callback) {
		createConnection(this, options, callback);
	}
}

class HttpsOverHttp2 extends https.Agent {
	constructor(options) {
		super(options);

		initialize(this, options.proxyOptions);
	}

	createConnection(options, callback) {
		createConnection(this, options, callback);
	}
}

module.exports = {
	HttpOverHttp2,
	HttpsOverHttp2
};
