'use strict';
const WebSocket = require('ws');
const http2 = require('../../source/index.js');

const head = Buffer.from('');

const connect = (url, options) => {
	const ws = new WebSocket(null);
	ws._isServer = false;

	const destroy = async error => {
		ws._readyState = WebSocket.CLOSING;

		await Promise.resolve();
		ws.emit('error', error);
	};

	(async () => {
		try {
			const stream = await http2.globalAgent.request(url, options, {
				...options,
				':method': 'CONNECT',
				':protocol': 'websocket',
				origin: (new URL(url)).origin
			});

			stream.once('error', destroy);

			stream.once('response', _headers => {
				stream.off('error', destroy);

				stream.setNoDelay = () => {};
				ws.setSocket(stream, head, 100 * 1024 * 1024);
			});
		} catch (error) {
			destroy(error);
		}
	})();

	return ws;
};

const ws = connect('https://localhost:3000', {
	// For demo purposes only!
	rejectUnauthorized: false
});

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
