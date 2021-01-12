'use strict';
const http2 = require('..');
const WebSocket = require('ws');

const connect = url => {
	const ws = new WebSocket(null);

	const destroy = error => {
		ws._readyState = WebSocket.CLOSING;

		ws.emit('error', error);
	};

	(async () => {
		try {
			const stream = await http2.globalAgent.request(url, undefined, {
				':method': 'CONNECT',
				':protocol': 'websocket',
				'sec-websocket-version': 13,
				origin: (new URL(url)).origin
			});

			stream.once('error', destroy);

			stream.once('response', headers => {
				stream.off('error', destroy);

				ws.setSocket(stream, headers, 100 * 1024 * 1024);
			});
		} catch (error) {
			destroy(error);
		}
	})();

	return ws;
};

const ws = connect('https://example.com');

ws.once('open', () => {
	console.log('CONNECTED!');

	ws.send('WebSockets over HTTP/2');
});

ws.once('close', () => {
	console.log('DISCONNECTED!');
});

ws.once('message', message => {
	console.log(message);

	ws.close();
});

ws.once('error', error => {
	console.error(error);
});
