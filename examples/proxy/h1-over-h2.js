'use strict';
const https = require('https');
const http2 = require('../../source'); // Note: using the local version
const {Agent} = https;

class H1overH2 extends Agent {
	constructor(origin, options) {
		super(options);

		this.h2origin = origin;
	}

	createConnection(options, callback) {
		void (async () => {
			try {
				const stream = await http2.globalAgent.request(this.h2origin, {
					// For demo purposes only!
					rejectUnauthorized: false
				}, {
					':method': 'CONNECT',
					':authority': `${options.host}:${options.port}`
				});

				stream.once('error', callback);
				stream.once('response', headers => {
					const status = headers[':status'];

					if (status !== 200) {
						callback(new Error(`The proxy server rejected the request with status code ${status}`));
					}

					callback(null, stream);
				});
			} catch (error) {
				callback(error);
			}
		})();
	}
}

const request = https.request('https://httpbin.org/anything', {
	agent: new H1overH2('https://localhost:8000'),
	method: 'POST'
}, response => {
	console.log('statusCode:', response.statusCode);
	console.log('headers:', response.headers);

	const body = [];
	response.on('data', chunk => {
		body.push(chunk);
	});
	response.on('end', () => {
		console.log('body:', Buffer.concat(body).toString());
	});
});

request.on('error', console.error);

request.write('123');
request.end('456');
