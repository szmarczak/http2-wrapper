const http2wrapper = require('../../source/index.js');
const tls = require('tls');

(async () => {
	const agentOptions = {
		proxyOptions: {
			url: new URL('https://username:password@localhost:8000'),

			rejectUnauthorized: false
		}
	};

	const destination = new URL('https://httpbin.org/anything');
	const host = `${destination.host}:${destination.port || 443}`;

	const request = await http2wrapper.auto(agentOptions.proxyOptions.url, {
		rejectUnauthorized: agentOptions.proxyOptions.rejectUnauthorized,
		method: 'CONNECT',
		headers: {
			host,
			authorization: `basic ${Buffer.from('username:password').toString('base64')}`
		},
		path: host
	});

	request.end();

	request.once('connect', (response, socket) => {
		const tlsSocket = tls.connect(443, destination.host, {
			socket,
			servername: 'httpbin.org',
			ALPNProtocols: ['h2', 'http/1.1']
		});

		tlsSocket.once('secure', () => {
			console.log('handshake done');
			console.log(tlsSocket.alpnProtocol);
		});
	});
})();
