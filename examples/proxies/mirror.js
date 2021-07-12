'use strict';
const proxy = require('http2-proxy');
const http2 = require('../../source/index.js'); // Note: using the local version
const {key, cert} = require('../../test/helpers/certs.js');

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

server.listen(8002, error => {
	if (error) {
		throw error;
	}

	server.on('request', (serverRequest, serverResponse) => {
		proxy.web(serverRequest, serverResponse, {
			protocol: 'https:',
			hostname: 'httpbin.org',
			port: 443,
			onReq: async (request, options) => {
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
