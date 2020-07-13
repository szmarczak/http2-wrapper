'use strict';
const http = require('http');
const https = require('https');
const {globalAgent} = require('../agent');
const UnexpectedStatusCodeError = require('./unexpected-status-code-error');

const initialize = (self, {url, proxyOptions = {}}) => {
	self.origin = new URL(url);
	self.proxyOptions = {...proxyOptions, headers: {...proxyOptions.headers}};

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
				':protocol': self.proxyOptions.extendedProtocol,
				...self.proxyOptions.headers
			});

			stream.once('error', callback);
			stream.once('response', headers => {
				const statusCode = headers[':status'];

				if (statusCode !== 200) {
					callback(new UnexpectedStatusCodeError(statusCode));
				}

				callback(null, stream);
			});
		} catch (error) {
			callback(error);
		}
	})();
};

class H1overH2 extends http.Agent {
	constructor(args) {
		super(args.agentOptions);

		initialize(this, args);
	}

	createConnection(options, callback) {
		createConnection(this, options, callback);
	}
}

class H1SoverH2 extends https.Agent {
	constructor(args) {
		super(args.agentOptions);

		initialize(this, args);
	}

	createConnection(options, callback) {
		createConnection(this, options, callback);
	}
}

module.exports = {
	H1overH2,
	H1SoverH2
};
