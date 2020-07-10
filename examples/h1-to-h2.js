const http = require('http');
const proxy = require('http2-proxy');
const http2 = require('../source'); // Note: using the local version

const server = http.createServer();

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

	server.on('request', (serverRequest, serverResponse) => {
		proxy.web(serverRequest, serverResponse, {
			hostname: 'example.com',
			port: 443,
			onReq: (request, options) => {
				const h2request = http2.request(options, response => {
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
