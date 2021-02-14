'use strict';
const net = require('net');
const tls = require('tls');
const {
	STATUS_CODES,
	createServer: createHttpServer
} = require('http');
const http2 = require('http2');

const safeUrl = (...args) => {
	try {
		return new URL(...args);
	} catch {
		return undefined;
	}
};

const readAlpn = header => {
	if (header) {
		return header.split(',').map(x => x.trim());
	}

	return undefined;
};

module.exports = (options = {}) => {
	const createServer = options.key && options.cert ? http2.createSecureServer : createHttpServer;

	const server = createServer({
		settings: {
			enableConnectProtocol: true
		},
		allowHTTP1: true,
		...options
	});

	server.proxied = [];
	server.proxiedCounter = 0;

	if (typeof options.authorize !== 'function') {
		throw new TypeError('The `authorize` option needs to be a function');
	}

	const {authorize} = options;

	const validateCredentials = headers => {
		const proxyAuthorization = headers['proxy-authorization'] || headers.authorization;
		if (!proxyAuthorization) {
			return false;
		}

		const [type, credentials] = proxyAuthorization.split(' ');

		return authorize(type.toLowerCase(), credentials);
	};

	const sendStatus = (source, statusCode) => {
		if ('rstCode' in source) {
			source.respond({':status': statusCode});
			source.end();
		} else {
			source.end(`HTTP/1.1 ${statusCode} ${STATUS_CODES[statusCode]}\r\n\r\n`);
		}
	};

	const connect = (source, headers, url, head) => {
		const isHttp2 = 'rstCode' in source;

		if (validateCredentials(headers, source) === false) {
			sendStatus(source, 403);
			return;
		}

		if (url.startsWith('/') || url.includes('/')) {
			sendStatus(source, 400);
			return;
		}

		const ALPNProtocols = readAlpn(headers['alpn-protocols']);
		const target = safeUrl(`${ALPNProtocols ? 'tls:' : 'tcp:'}//${url}`);

		if (target === undefined || target.port === '') {
			sendStatus(source, 400);
			return;
		}

		const network = target.protocol === 'tls:' ? tls : net;

		const socket = network.connect(target.port, target.hostname, {
			ALPNProtocols
		}, () => {
			if (isHttp2) {
				source.respond();
			} else {
				socket.write(head);

				const headers = network === tls ? `alpn-protocol: ${socket.alpnProtocol}\r\n` : '';
				source.write(`HTTP/1.1 200 Connection Established\r\n${headers}\r\n`);
			}

			socket.pipe(source);
			source.pipe(socket);
		});

		server.proxied.push(socket);
		server.proxiedCounter++;

		socket.once('error', () => {
			if (isHttp2) {
				source.close(http2.constants.NGHTTP2_CONNECT_ERROR);
			} else {
				source.destroy();
			}
		});

		socket.once('close', () => {
			server.proxied.splice(server.proxied.indexOf(socket), 1);

			source.destroy();
		});

		source.once('error', () => {
			socket.destroy();
		});

		source.once('close', () => {
			socket.destroy();
		});

		return socket;
	};

	server.on('stream', (stream, headers) => {
		if (headers[':method'] !== 'CONNECT') {
			return;
		}

		try {
			const proxied = connect(stream, headers, headers[':authority']);

			server.emit('proxied', stream, proxied);
		} catch {
			sendStatus(stream, 500);
		}
	});

	server.on('connect', (request, socket, head) => {
		if (request.stream) {
			// Node.js bugs... Node.js bugs everywhere...
			return;
		}

		try {
			const proxied = connect(socket, request.headers, request.url, head);

			server.emit('proxied', socket, proxied);
		} catch {
			sendStatus(socket, 500);
		}
	});

	server.on('request', (request, response) => {
		if (server.listenerCount('request') === 1) {
			response.statusCode = 501;
			response.end();
		}
	});

	return server;
};
