'use strict';
const {globalAgent} = require('../agent');
const Http2OverHttpX = require('./h2-over-hx');

const getStatusCode = stream => new Promise((resolve, reject) => {
	stream.once('error', reject);
	stream.once('response', headers => {
		stream.off('error', reject);
		resolve(headers[':status']);
	});
});

class Http2OverHttp2 extends Http2OverHttpX {
	async _getProxyStream(authority) {
		const stream = await globalAgent.request(this.origin, this.proxyOptions, {
			':method': 'CONNECT',
			':authority': authority,
			...this.proxyOptions.headers
		});

		const statusCode = await getStatusCode(stream);

		return [stream, statusCode];
	}
}

module.exports = Http2OverHttp2;
