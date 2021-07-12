'use strict';
const {key, cert} = require('../../test/helpers/certs.js');
const createProxyServer = require('../../proxy-server.js');

const authorize = (type, credentials) => {
	try {
		if (type !== 'basic') {
			return false;
		}

		const plain = Buffer.from(credentials, 'base64').toString();

		if (plain !== 'username:password') {
			return false;
		}
	} catch {
		return false;
	}
};

const server = createProxyServer({
	authorize,
	key,
	cert
});

const unsecureServer = createProxyServer({
	authorize
});

server.listen(8000, error => {
	if (error) {
		throw error;
	}

	console.log(`[https] Listening on port ${server.address().port}`);
});

unsecureServer.listen(8001, error => {
	if (error) {
		throw error;
	}

	console.log(`[http] Listening on port ${unsecureServer.address().port}`);
});
