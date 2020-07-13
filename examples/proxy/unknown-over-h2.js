'use strict';
const http2 = require('../../source'); // Note: using the local version

const H1Agent = new http2.proxies.H1overH2({
	url: 'https://username:password@localhost:8000',
	proxyOptions: {
		// Remove the following line if the server doesn't support the extended CONNECT protocol
		extendedProtocol: 'tcp',
		// For demo purposes only!
		rejectUnauthorized: false
	}
});

const H1SAgent = new http2.proxies.H1SoverH2({
	url: 'https://username:password@localhost:8000',
	proxyOptions: {
		// Remove the following line if the server doesn't support the extended CONNECT protocol
		extendedProtocol: 'tls',
		// For demo purposes only!
		rejectUnauthorized: false
	}
});

const H2Agent = new http2.proxies.H2overH2({
	url: 'https://username:password@localhost:8000',
	proxyOptions: {
		// Remove the following line if the server doesn't support the extended CONNECT protocol
		extendedProtocol: 'tcp',
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
