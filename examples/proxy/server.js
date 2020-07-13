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

const defaultWebHandler = (error, request, response) => {
	if (error) {
		console.error(error);

		if (response.writeHead) {
			response.statusCode = error.statusCode || 500;
			response.end(error.stack);
		} else {
			response.end('HTTP/1.1 403 Unauthorized\r\n\r\n');
		}
	}
};

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

	// Support for the CONNECT protocol
	server.on('connect', (serverRequest, serverResponse, head) => {
		try {
			validateCredentials(serverRequest);
		} catch (error) {
			defaultWebHandler(error, serverRequest, serverResponse);
			return;
		}

		let protocol = serverRequest.headers[':protocol'] || 'tls:';
		if (!protocol.endsWith(':')) {
			protocol += ':';
		}

		if (serverResponse.writeHead) {
			serverResponse.writeHead();
		} else {
			// Always default TCP for HTTP/1.1 for demo purposes only!
			protocol = 'tcp:';
		}

		const host = serverRequest.headers[':authority'] || serverRequest.url.slice(1);

		const auth = new URL(`${protocol}//${host}`);

		const network = protocol === 'tls:' ? tls : net;
		const defaultPort = protocol === 'tls:' ? 443 : 80;

		const socket = network.connect(auth.port || defaultPort, auth.hostname, () => {
			if (!serverResponse.writeHead) {
				serverResponse.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				socket.write(head);
			}

			socket.pipe(serverResponse);

			if (serverResponse.writeHead) {
				serverRequest.pipe(socket);
			} else {
				serverResponse.pipe(socket);
			}
		});

		socket.on('error', error => {
			serverResponse.statusCode = 500;
			serverResponse.end(error.stack);
		});
	});

	server.on('request', (serverRequest, serverResponse) => {
		proxy.web(serverRequest, serverResponse, {
			hostname: 'example.com',
			port: 443,
			onReq: async (request, options) => {
				validateCredentials(request);

				const h2request = await http2.auto(options, response => {
					const {headers} = response;

					// `http2-proxy` doesn't automatically remove pseudo-headers
					for (const name in headers) {
						if (name.startsWith(':')) {
							delete headers[name];
						}
					}
				});

				// `http2-proxy` waits for the `socket` event before calling `h2request.end()`
				h2request.flushHeaders();

				return h2request;
			}
		}, defaultWebHandler);
	});

	console.log(`Listening on port ${server.address().port}`);
});
