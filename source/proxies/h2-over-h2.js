'use strict';
const {Agent, globalAgent} = require('../agent');
const UnexpectedStatusCodeError = require('./unexpected-status-code-error');

const getStatusCode = stream => new Promise((resolve, reject) => {
	stream.once('error', reject);
	stream.once('response', headers => {
		stream.off('error', reject);
		resolve(headers[':status']);
	});
});

class H2overH2 extends Agent {
	constructor({url, proxyOptions = {}, agentOptions}) {
		super(agentOptions);

		this.origin = new URL(url);
		this.proxyOptions = proxyOptions;

		const {username, password} = this.origin;
		if (username || password) {
			const data = `${username}:${password}`;
			this.proxyOptions.authorization = `Basic ${Buffer.from(data).toString('base64')}`;
		}
	}

	async getSession(origin, options, listeners) {
		try {
			if (!(origin instanceof URL)) {
				origin = new URL(origin);
			}

			// Include the port in case the proxy server incorrectly guesses it
			const authority = `${origin.hostname}:${origin.port || 443}`;

			const stream = await globalAgent.request(this.origin, this.proxyOptions, {
				':method': 'CONNECT',
				':authority': authority,
				':protocol': this.proxyOptions.extendedProtocol,
				'proxy-authorization': this.proxyOptions.authorization
			});

			const statusCode = await getStatusCode(stream);
			if (statusCode !== 200) {
				throw new UnexpectedStatusCodeError(statusCode);
			}

			options.socket = stream;

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

module.exports = H2overH2;
