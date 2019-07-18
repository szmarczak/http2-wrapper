'use strict';
const resolveALPN = require('resolve-alpn');
const calculateServerName = require('./calculate-server-name');
const isCompatible = require('./is-compatible');

const ALPNProtocols = isCompatible ? ['h2', 'http/1.1'] : ['http/1.1'];

// Transforms HTTP options into Socket options and resolves ALPN.
module.exports = (options, headers) => {
	return resolveALPN({
		ALPNProtocols,
		...options,
		port: options.port || 443,
		host: options.hostname || options.host,
		path: options.socketPath,
		session: options.socketSession,
		servername: options.servername || calculateServerName(options, headers || {})
	});
};
