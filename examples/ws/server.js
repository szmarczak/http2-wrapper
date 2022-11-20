'use strict';
const http2 = require('http2');
const WebSocket = require('ws');
const {key, cert} = require('../../test/helpers/certs.js');

const head = Buffer.from('');

const server = http2.createSecureServer({
	key,
	cert,
	settings: {
		enableConnectProtocol: true
	}
});

server.on('stream', (stream, headers) => {
	if (headers[':method'] === 'CONNECT') {
		stream.respond();

		const ws = new WebSocket(null);
		stream.setNoDelay = () => {};
		ws.setSocket(stream, head, 100 * 1024 * 1024);

		ws.on('message', data => {
			ws.send(data);
		});
	} else {
		stream.respond();
		stream.end('ok');
	}
});

server.listen(3000, error => {
	if (error) {
		throw error;
	}

	console.log(`Listening on port ${server.address().port}`);
});
