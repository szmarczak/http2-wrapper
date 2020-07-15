'use strict';
const http2 = require('../../source'); // Note: using the local version
const HttpsProxyAgent = require('https-proxy-agent');

const {
	HttpOverHttp2,
	HttpsOverHttp2,
	Http2OverHttp2,
	Http2OverHttps
} = http2.proxies;

(async () => {
	const proxy = {
		url: new URL('https://username:password@localhost:8000'),
		proxyOptions: {
			// If the proxy doesn't process TLS sockets automatically, set this to `true`.
			raw: true,

			// For demo purposes only!
			rejectUnauthorized: false
		}
	};

	const proxyUrl = proxy.url;

	let agent;

	try {
		if (proxyUrl.protocol === 'https:') {
			const alpnProtocol = await http2.auto.resolveProtocol({
				host: proxyUrl.hostname,
				servername: proxyUrl.hostname,
				port: proxyUrl.port,
				ALPNProtocols: ['h2', 'http/1.1'],

				// For demo purposes only!
				rejectUnauthorized: false
			});

			let agent;
			if (alpnProtocol === 'h2') {
				agent = {
					http: new HttpOverHttp2(proxy),
					https: new HttpsOverHttp2(proxy),
					http2: new Http2OverHttp2(proxy)
				};
			} else {
				agent = {
					http: new HttpsProxyAgent(proxy.url.href),
					https: new HttpsProxyAgent(proxy.url.href),
					http2: new Http2OverHttps(proxy)
				};
			}
		} else {
			throw new Error('Not implemented');

			// agent = {
			// 	http: new HttpOverHttp(proxy),
			// 	https: new HttpsOverHttp(proxy),
			// 	http2: new Http2OverHttp(proxy),
			// };
		}
	} catch (error) {
		console.error(`Could not retrieve the ALPN protocol of ${proxyUrl.origin} - ${error.message}`);
		return;
	}

	try {
		const request = await http2.auto('https://httpbin.org/anything', {
			method: 'POST',
			agent
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
	} catch (error) {
		console.error(error);
	}
})();
