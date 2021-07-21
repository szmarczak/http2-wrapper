'use strict';
const HttpsProxyAgent = require('https-proxy-agent');
const tls = require('tls');
const http2 = require('../../source/index.js'); // Note: using the local version

const {
	HttpOverHttp2,
	HttpsOverHttp2,
	Http2OverHttp2,
	Http2OverHttps,
	Http2OverHttp
} = http2.proxies;

const resolveAlpnProxy = new URL('https://username:password@localhost:8000');
const connect = async (options, callback) => new Promise((resolve, reject) => {
	const host = `${options.host}:${options.port}`;

	(async () => {
		try {
			const request = await http2.auto(resolveAlpnProxy, {
				method: 'CONNECT',
				headers: {
					host
				},
				path: host,

				// For demo purposes only!
				rejectUnauthorized: false,
			});

			request.end();

			request.once('connect', (response, socket, head) => {
				if (head.length > 0) {
					reject(new Error(`Unexpected data before CONNECT tunnel: ${head.length} bytes`));

					socket.destroy();
					return;
				}

				const tlsSocket = tls.connect({
					...options,
					socket
				}, callback);

				resolve(tlsSocket);
			});
		} catch (error) {
			reject(error);
		}
	})();
});

// This is required to prevent leaking real IP address on ALPN negotiation
const resolveProtocol = http2.auto.createResolveProtocol(new Map(), new Map(), connect);

(async () => {
	const proxy = {
		proxyOptions: {
			url: new URL('https://username:password@localhost:8000'),

			// For demo purposes only!
			rejectUnauthorized: false
		}
	};

	const proxyUrl = proxy.proxyOptions.url;

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

			if (alpnProtocol === 'h2') {
				agent = {
					http: new HttpOverHttp2(proxy),
					https: new HttpsOverHttp2(proxy),
					http2: new Http2OverHttp2(proxy)
				};
			} else {
				agent = {
					http: new HttpsProxyAgent(proxyUrl.href),
					https: new HttpsProxyAgent(proxyUrl.href),
					http2: new Http2OverHttps(proxy)
				};
			}
		} else {
			agent = {
				http: () => {
					throw new Error('Not implemented');
				},
				https: () => {
					throw new Error('Not implemented');
				},
				http2: new Http2OverHttp(proxy)
			};
		}
	} catch (error) {
		console.error(`Could not retrieve the ALPN protocol of ${proxyUrl.origin} - ${error.message}`);
		return;
	}

	try {
		const request = await http2.auto('https://httpbin.org/anything', {
			method: 'POST',
			agent,
			resolveProtocol
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
