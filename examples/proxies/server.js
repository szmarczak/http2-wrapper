'use strict';
const net = require('net');
const tls = require('tls');
const {STATUS_CODES} = require('http');
const http2 = require('../../source'); // Note: using the local version
const {key, cert} = require('../../test/helpers/certs');

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

const server = http2.createSecureServer({
	key,
	cert,
	settings: {
		enableConnectProtocol: true
	},
	allowHTTP1: true
});

const validateCredentials = headers => {
	const proxyAuthorization = headers['proxy-authorization'] || headers.authorization;
	if (!proxyAuthorization) {
		return false;
	}

	const [authorization, encryptedCredentials] = proxyAuthorization.split(' ');
	if (authorization.toLocaleLowerCase() !== 'basic') {
		return false;
	}

	const plainCredentials = Buffer.from(encryptedCredentials, 'base64').toString();
	if (plainCredentials !== 'username:password') {
		return false;
	}
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

	if (isHttp2 && headers[':method'] !== 'CONNECT') {
		if (server.listenerCount('request') === 0) {
			sendStatus(source, 501);
		}

		return;
	}

	if (validateCredentials(headers) === false) {
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

	const socket = network.connect(target.port, target.hostname, {ALPNProtocols}, () => {
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

	socket.on('error', () => {
		if (isHttp2) {
			source.close(http2.constants.NGHTTP2_CONNECT_ERROR);
		} else {
			source.destroy();
		}
	});

	source.once('error', () => {
		socket.destroy();
	});
};

server.on('stream', (stream, headers) => {
	connect(stream, headers, stream.url);
});

server.on('connect', (request, socket, head) => {
	connect(socket, request.headers, request.url, head);
});

server.listen(8000, error => {
	if (error) {
		throw error;
	}

	console.log(`Listening on port ${server.address().port}`);
});
