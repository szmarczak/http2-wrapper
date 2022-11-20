'use strict';
const http2 = require('http2');
const {cert, key} = require('../../test/helpers/certs.js');

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

server.listen(3000, error => {
	if (error) {
		throw error;
	}

	console.log(`Listening on port ${server.address().port}`);
});
