'use strict';
const net = require('net');
const tls = require('tls');
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

const badRequest = socket => {
	socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
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

server.listen(8000, error => {
	if (error) {
		throw error;
	}

	server.on('stream', (stream, headers) => {
		if (headers[':method'] !== 'CONNECT') {
			if (server.listenerCount('request') === 0) {
				stream.respond({':status': '501'});
				stream.end();
			}

			return;
		}

		if (validateCredentials(headers) === false) {
			stream.respond({':status': '403'});
			stream.end();
			return;
		}

		const ALPNProtocols = readAlpn(headers['alpn-protocols']);
		const target = safeUrl(`${ALPNProtocols ? 'tls:' : 'tcp:'}//${stream.url}`);

		if (target === undefined || target.port === '') {
			stream.respond({':status': '400'});
			stream.end();
			return;
		}

		const network = target.protocol === 'tls:' ? tls : net;

		const socket = network.connect(target.port, target.hostname, {ALPNProtocols}, () => {
			stream.respond();

			socket.pipe(stream);
			stream.pipe(socket);
		});

		socket.on('error', () => {
			stream.close(http2.constants.NGHTTP2_CONNECT_ERROR);
		});

		stream.once('error', () => {
			socket.destroy();
		});
	});

	server.on('connect', (request, requestSocket, head) => {
		if (validateCredentials(request.headers) === false) {
			requestSocket.end('HTTP/1.1 403 Unauthorized\r\n\r\n');
			return;
		}

		if (request.url.startsWith('/') || request.url.includes('/')) {
			badRequest(requestSocket);
			return;
		}

		const ALPNProtocols = readAlpn(request.headers['alpn-protocols']);
		const target = safeUrl(`${ALPNProtocols ? 'tls:' : 'tcp:'}//${request.url}`);

		if (target === undefined || target.port === '') {
			badRequest(requestSocket);
			return;
		}

		const network = target.protocol === 'tls:' ? tls : net;

		const socket = network.connect(target.port, target.hostname, {ALPNProtocols}, () => {
			const headers = network === tls ? `alpn-protocol: ${socket.alpnProtocol}\r\n` : '';

			requestSocket.write(`HTTP/1.1 200 Connection Established\r\n${headers}\r\n`);
			socket.write(head);

			socket.pipe(requestSocket);
			requestSocket.pipe(socket);
		});

		socket.once('error', () => {
			requestSocket.destroy();
		});

		requestSocket.once('error', () => {
			socket.destroy();
		});
	});

	console.log(`Listening on port ${server.address().port}`);
});
