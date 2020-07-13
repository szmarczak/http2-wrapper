'use strict';
const net = require('net');
const tls = require('tls');
const proxy = require('http2-proxy');
const http2 = require('../../source'); // Note: using the local version
const {key, cert} = require('../../test/helpers/certs');

const server = http2.createSecureServer({
	key,
	cert,
	settings: {
		enableConnectProtocol: true
	},
	allowHTTP1: true
});

const validateCredentials = request => {
	const proxyAuthorization = request.headers['proxy-authorization'] || request.headers.authorization;
	if (!proxyAuthorization) {
		const error = new Error('Unauthorized.');
		error.statusCode = 403;

		throw error;
	}

	const [authorization, encryptedCredentials] = proxyAuthorization.split(' ');
	if (authorization.toLocaleLowerCase() !== 'basic') {
		const error = new Error(`Unsupported authorization method: ${authorization}`);
		error.statusCode = 403;
		error.authorization = authorization;

		throw error;
	}

	const plainCredentials = Buffer.from(encryptedCredentials, 'base64').toString();
	if (plainCredentials !== 'username:password') {
		const error = new Error('Incorrect username or password');
		error.statusCode = 403;
		error.plainCredentials = plainCredentials;

		throw error;
	}
};

server.listen(8000, error => {
	if (error) {
		throw error;
	}

	server.on('stream', (stream, headers) => {
		stream.once('error', (error) => {
			console.log(error);
		});

		try {
			validateCredentials({headers});
		} catch (error) {
			console.error(error);
			stream.respond({':status': error.statusCode});
			stream.end(error.stack);
			return;
		}

		if (headers[':method'] !== 'CONNECT') {
			stream.close(NGHTTP2_REFUSED_STREAM);
			return;
		}

		let protocol = headers[':protocol'] || 'tls:';
		if (!protocol.endsWith(':')) {
			protocol += ':';
		}

		const auth = new URL(`${protocol}//${headers[':authority']}`);

		const network = protocol === 'tls:' ? tls : net;
		const defaultPort = protocol === 'tls:' ? 443 : 80;

		const socket = network.connect(auth.port || defaultPort, auth.hostname, () => {
			stream.respond();
			socket.pipe(stream);
			stream.pipe(socket);
		});

		socket.on('error', error => {
			stream.close(http2.constants.NGHTTP2_CONNECT_ERROR);
		});

		stream.once('close', () => {
			socket.destroy();
		});
	});

	server.on('connect', (request, stream, head) => {
		try {
			validateCredentials(request);
		} catch (error) {
			console.error(error);
			response.end('HTTP/1.1 403 Unauthorized\r\n\r\n');
			return;
		}

		const auth = new URL(`tcp://${request.url.slice(1)}`);

		const protocol = 'tcp:';
		const network = protocol === 'tls:' ? tls : net;
		const defaultPort = protocol === 'tls:' ? 443 : 80;

		const socket = network.connect(auth.port || defaultPort, auth.hostname, () => {
			stream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			socket.write(head);

			socket.pipe(stream);
			stream.pipe(socket);
		});

		socket.once('error', error => {
			stream.destroy();
		});

		stream.once('error', error => {
			socket.destroy();
		});
	});

	console.log(`Listening on port ${server.address().port}`);
});
