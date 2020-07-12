const http2 = require('../../source'); // Note: using the local version
const {Agent} = http2;

class ProxyAgent extends Agent {
	constructor(url, options) {
		super(options);

		this.origin = url;
	}

	request(origin, sessionOptions, headers, streamOptions) {
		const url = new URL(origin);

		// For demo purposes only!
		sessionOptions.rejectUnauthorized = false;

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
	method: 'POST',
	headers: {
		'content-length': 6
	},
	agent: new ProxyAgent('https://localhost:8000')
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
