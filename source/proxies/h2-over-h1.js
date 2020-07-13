'use strict';
const http = require('http');
const https = require('https');
const {Agent} = require('../agent');
const UnexpectedStatusCodeError = require('./unexpected-status-code-error');

const getStream = request => new Promise((resolve, reject) => {
	const onConnect = (response, socket, head) => {
		if (response.statusCode !== 200) {
			reject(new UnexpectedStatusCodeError(response.statusCode));
			return;
		}

		if (head.length !== 0) {
			reject(new Error(`Unexpected data: ${head}`));
			return;
		}

		request.off('error', reject);
		resolve(socket);
	};

	request.once('error', reject);
	request.once('connect', onConnect);
});

class H2overH1 extends Agent {
	constructor({url, proxyOptions = {}, agentOptions}) {
		super(agentOptions);

		this.origin = new URL(url);
		this.proxyOptions = proxyOptions;

		const {username, password} = this.origin;
		if (username || password) {
			const data = `${username}:${password}`;
			this.proxyOptions.authorization = `Basic ${Buffer.from(data).toString('base64')}`;
		}

		this.origin.username = '';
		this.origin.password = '';
	}

	async getSession(origin, options = {}, listeners = []) {
		if (!(origin instanceof URL)) {
			origin = new URL(origin);
		}

		const network = this.origin.protocol === 'https:' ? https : http;

		const request = network.request(`${this.origin}${origin.hostname}:${origin.port || 443}`, {
			...this.proxyOptions,
			headers: {
				...this.proxyOptions.headers,
				'proxy-authorization': this.proxyOptions.authorization
			},
			method: 'CONNECT'
		}).end();

		try {
			const stream = await getStream(request);

			options.socket = stream;

			return super.getSession(origin, options, listeners);
		} catch (error) {
			request.destroy();

			if (listeners.length === 0) {
				throw error;
			}

			for (const {reject} of listeners) {
				reject(error);
			}
		}
	}
}

module.exports = H2overH1;
