'use strict';
const http = require('http');
const https = require('https');
const Http2OverHttpX = require('./h2-over-hx');

const getStream = request => new Promise((resolve, reject) => {
	const onConnect = (response, socket, head) => {
		if (head.length > 0) {
			reject(new Error(`Unexpected data: ${head}`));
			return;
		}

		request.off('error', reject);
		resolve([socket, response.statusCode]);
	};

	request.once('error', reject);
	request.once('connect', onConnect);
});

class Http2OverHttp extends Http2OverHttpX {
	async _getProxyStream(authority) {
		const network = this.origin.protocol === 'https:' ? https : http;

		// `new URL('https://localhost/httpbin.org:443')` results in
		// a `/httpbin.org:443` path, which has an invalid leading slash.
		const request = network.request({
			hostname: this.origin.hostname,
			port: this.origin.port,
			path: authority,
			...this.proxyOptions,
			headers: {
				...this.proxyOptions.headers,
				host: authority
			},
			method: 'CONNECT'
		}).end();

		return getStream(request);
	}
}

module.exports = {
	Http2OverHttp,
	Http2OverHttps: Http2OverHttp
};
