'use strict';
const http2 = require('../../source/index.js'); // Note: using the local version

const H1Agent = new http2.proxies.HttpOverHttp2({
	proxyOptions: {
		url: 'https://username:password@localhost:8000',

		// For demo purposes only!
		rejectUnauthorized: false
	}
});

const H1SAgent = new http2.proxies.HttpsOverHttp2({
	proxyOptions: {
		url: 'https://username:password@localhost:8000',

		// For demo purposes only!
		rejectUnauthorized: false
	}
});

const H2Agent = new http2.proxies.Http2OverHttp2({
	proxyOptions: {
		url: 'https://username:password@localhost:8000',

		// For demo purposes only!
		rejectUnauthorized: false
	}
});

const agent = {
	http: H1Agent,
	https: H1SAgent,
	http2: H2Agent
};

(async () => {
	try {
		const request = await http2.auto({
			// Try changing this to: http/1.1
			ALPNProtocols: ['h2'],
			hostname: 'httpbin.org',
			// Try changing this to: http:
			protocol: 'https:',
			path: '/anything',
			method: 'POST',
			agent
		}, response => {
			const isSecure = response.req.agent.protocol === 'https:';
			const protocol = isSecure ? `http/${response.httpVersion} with TLS` : 'http/1.1 without TLS';

			console.log('statusCode:', response.statusCode);
			console.log('headers:', response.headers);
			console.log('protocol:', protocol);

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
	} catch (error) {
		console.error(error);
	}
})();
