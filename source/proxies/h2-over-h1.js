'use strict';
// See https://github.com/facebook/jest/issues/2549
// eslint-disable-next-line node/prefer-global/url
const {URL} = require('url');
const http = require('http');
const https = require('https');
const {Agent} = require('../agent');
const JSStreamSocket = require('../utils/js-stream-socket');
const UnexpectedStatusCodeError = require('./unexpected-status-code-error');

const getStream = request => new Promise((resolve, reject) => {
	const onConnect = (response, socket, head) => {
		if (response.statusCode !== 200) {
			reject(new UnexpectedStatusCodeError(response.statusCode));
			return;
		}

		if (head.length > 0) {
			reject(new Error(`Unexpected data: ${head}`));
			return;
		}

		request.off('error', reject);
		resolve(socket);
	};

	request.once('error', reject);
	request.once('connect', onConnect);
});

class Http2OverHttp extends Agent {
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

		this.origin.username = '';
		this.origin.password = '';
	}

	async getSession(origin, options = {}, listeners = []) {
		if (!(origin instanceof URL)) {
			origin = new URL(origin);
		}

		const network = this.origin.protocol === 'https:' ? https : http;

		// `new URL('https://localhost/httpbin.org:443')` results in
		// a `/httpbin.org:443` path, which has an invalid leading slash.
		const request = network.request({
			hostname: this.origin.hostname,
			port: this.origin.port,
			path: `${origin.hostname}:${origin.port || 443}`,
			...this.proxyOptions,
			headers: {
				...this.proxyOptions.headers,
				host: `${origin.hostname}:${origin.port || 443}`
			},
			method: 'CONNECT'
		}).end();

		try {
			const stream = await getStream(request);

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

module.exports = {
	Http2OverHttp,
	Http2OverHttps: Http2OverHttp
};
