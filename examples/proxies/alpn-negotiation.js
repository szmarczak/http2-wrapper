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
			host
		},
		path: host
	});

	request.end();

	request.once('connect', (response, socket, head) => {
		if (head.length > 0) {
			// Handle unexpected data
			return;
		}

		const tlsSocket = tls.connect({
			socket,
			servername: destination.hostname,
			ALPNProtocols: ['h2', 'http/1.1']
		});

		tlsSocket.once('secure', () => {
			console.log('handshake done');
			console.log(tlsSocket.alpnProtocol);
		});
	});
})();
