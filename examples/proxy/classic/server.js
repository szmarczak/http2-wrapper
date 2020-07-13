'use strict';
const proxy = require('http2-proxy');
const http2 = require('../../../source'); // Note: using the local version
const {key, cert} = require('../../../test/helpers/certs');

const server = http2.createSecureServer({
	key,
	cert,
	allowHTTP1: true
});

const defaultWebHandler = (error, request, response) => {
	if (error) {
		console.error(error);

		response.statusCode = error.statusCode || 500;
		response.end(error.stack);
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

server.listen(8001, error => {
	if (error) {
		throw error;
	}

	server.on('request', (serverRequest, serverResponse) => {
		try {
			validateCredentials(serverRequest);
		} catch (error) {
			defaultWebHandler(error, serverRequest, serverResponse);
			return;
		}

		proxy.web(serverRequest, serverResponse, {
			onReq: async (request, options) => {
				const urlString = options.path.slice(1);

				delete options.path;

				console.log(urlString);

				const h2request = await http2.auto(urlString, options, response => {
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
