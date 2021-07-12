'use strict';
const https = require('https');
const http2 = require('../../source/index.js'); // Note: using the local version

const agent = new http2.proxies.HttpsOverHttp2({
	proxyOptions: {
		url: 'https://username:password@localhost:8000',

		// For demo purposes only!
		rejectUnauthorized: false
	}
});

const request = https.request('https://httpbin.org/anything', {
	agent,
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
