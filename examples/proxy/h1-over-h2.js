'use strict';
const https = require('https');
const http2 = require('http2');

const session = http2.connect('https://localhost:8000', {
	// For demo purposes only!
	rejectUnauthorized: false
});

session.ref();

https.request('https://httpbin.org/anything', {
	createConnection: options => {
		return session.request({
			':method': 'CONNECT',
			':authority': `${options.host}:${options.port}`
		});
	}
}, response => {
	console.log('statusCode:', response.statusCode);
	console.log('headers:', response.headers);

	const body = [];
	response.on('data', chunk => {
		body.push(chunk);
	});
	response.on('end', () => {
		console.log('body:', Buffer.concat(body).toString());

		session.unref();
	});
}).end();
