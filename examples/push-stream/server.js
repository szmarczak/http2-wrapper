'use strict';
const util = require('util');
const http2 = require('http2');
const keys = require('../../test/helpers/certs');

const PORT = 3000;

(async () => {
	const {cert, key} = keys;

	const server = http2.createSecureServer({cert, key});

	server.on('stream', stream => {
		stream.respond({':status': 200});
		stream.pushStream({':path': '/push'}, (error, pushStream) => {
			if (error) {
				throw error;
			}

			pushStream.respond({':status': 200});
			pushStream.end('some pushed data');
		});

		stream.end('some data');
	});

	server.listen = util.promisify(server.listen);
	server.close = util.promisify(server.close);

	await server.listen(PORT);

	console.log(`Server is listening on port ${PORT}`);
})();
