'use strict';
const http2 = require('.'); // Note: using local version

const options = {
	hostname: 'nghttp2.org',
	protocol: 'https:',
	path: '/httpbin/post',
	method: 'POST',
	headers: {
		'content-length': 6
	}
};

const req = http2.request(options, res => {
	console.log('statusCode:', res.statusCode);
	console.log('headers:', res.headers);

	const body = [];
	res.on('data', chunk => {
		body.push(chunk);
	});
	res.on('end', () => {
		console.log('body:', Buffer.concat(body).toString());
	});
});

req.on('error', e => console.error(e));

req.write('123');
req.end('456');
