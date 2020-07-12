'use strict';
const tls = require('tls');
const proxy = require('http2-proxy');
const http2 = require('../../source'); // Note: using the local version
const {key, cert} = require('../../test/helpers/certs');

const server = http2.createSecureServer({
	key,
	cert
});

const defaultWebHandler = (error, request, response) => {
	if (error) {
		console.error(error);

		response.statusCode = 500;
		response.end(error.stack);
	}
};

server.listen(8000, error => {
	if (error) {
		throw error;
	}

	// Support for the CONNECT protocol
	server.on('connect', (serverRequest, serverResponse) => {
		serverResponse.writeHead();

		const auth = new URL(`tls://${serverRequest.headers[':authority']}`);
		const socket = tls.connect(auth.port, auth.hostname, () => {
			socket.pipe(serverResponse);
			serverRequest.pipe(socket);
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
				// Support for custom authorities
				const authority = serverRequest.headers[':authority'];
				if (authority && !authority.startsWith('localhost')) {
					const [hostname, port] = request.headers[':authority'].split(':');

					options.hostname = hostname;
					options.port = port || options.port;
				}

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
