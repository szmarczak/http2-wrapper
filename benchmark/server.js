'use strict';
const http2 = require('http2');
const http = require('http');
const certs = require('../test/helpers/certs');

let counter = 0;

const requestHandler = (request, response) => {
	response.end('Hello, world!');
};

const listenHandler = error => {
	if (error) {
		throw error;
	}

	if (++counter === 2) {
		process.send('ok');
	}
};

const sslServer = http2.createSecureServer({
	...certs,
	allowHTTP1: true
}, requestHandler);

const server = http.createServer(requestHandler);

sslServer.listen(8081, listenHandler);
server.listen(8080, listenHandler);
