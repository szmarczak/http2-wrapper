'use strict';
// See https://github.com/facebook/jest/issues/2549
// eslint-disable-next-line node/prefer-global/url
const {URL} = require('url');
const {Agent, globalAgent} = require('../agent');
const JSStreamSocket = require('../utils/js-stream-socket');
const UnexpectedStatusCodeError = require('./unexpected-status-code-error');

const getStatusCode = stream => new Promise((resolve, reject) => {
	stream.once('error', reject);
	stream.once('response', headers => {
		stream.off('error', reject);
		resolve(headers[':status']);
	});
});

class Http2OverHttp2 extends Agent {
	constructor({url, proxyOptions = {}, agentOptions}) {
		super(agentOptions);

		this.origin = new URL(url);
		this.proxyOptions = {...proxyOptions, headers: {...proxyOptions.headers}};

		if (typeof proxyOptions.raw !== 'boolean') {
			throw new TypeError(`Expected 'proxyOptions.raw' to be a boolean, got ${typeof proxyOptions.raw}`);
		}

		const {username, password} = this.origin;
		if (username || password) {
			const data = `${username}:${password}`;
			this.proxyOptions.headers['proxy-authorization'] = `Basic ${Buffer.from(data).toString('base64')}`;
		}
	}

	async getSession(origin, options = {}, listeners = []) {
		try {
			if (!(origin instanceof URL)) {
				origin = new URL(origin);
			}

			// Include the port in case the proxy server incorrectly guesses it
			const authority = `${origin.hostname}:${origin.port || 443}`;

			const stream = await globalAgent.request(this.origin, this.proxyOptions, {
				':method': 'CONNECT',
				':authority': authority,
				...this.proxyOptions.headers
			});

			const statusCode = await getStatusCode(stream);
			if (statusCode !== 200) {
				throw new UnexpectedStatusCodeError(statusCode);
			}

			if (this.proxyOptions.raw) {
				options.socket = stream;
			} else {
				options.createConnection = () => {
					const socket = new JSStreamSocket(stream);
					socket.encrypted = true;
					socket.alpnProtocol = 'h2';
					socket.servername = origin.hostname;
					socket._handle.getpeername = out => {
						out.family = undefined;
						out.address = undefined;
						out.port = origin.port || undefined;
					};

					return socket;
				};
			}

			return super.getSession(origin, options, listeners);
		} catch (error) {
			if (listeners.length === 0) {
				throw error;
			}

			for (const {reject} of listeners) {
				reject(error);
			}
		}
	}
}

module.exports = Http2OverHttp2;
