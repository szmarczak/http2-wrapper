const http2 = require('../../source'); // Note: using the local version
const {Agent} = http2;

class ProxyAgent extends Agent {
	constructor(url, options) {
		super(options);

		this.origin = url;
	}

	request(origin, sessionOptions, headers, streamOptions) {
		const url = new URL(origin);

		return super.request(this.origin, sessionOptions, {
			...headers,
			':authority': url.host
		}, streamOptions);
	}
}

const request = http2.request({
	hostname: 'httpbin.org',
	protocol: 'https:',
	path: '/anything',
	agent: new ProxyAgent('https://localhost:8000'),
	// For demo purposes only!
	rejectUnauthorized: false
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

request.end();
