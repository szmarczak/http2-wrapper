'use strict';
const http = require('http');
const https = require('https');
const resolveALPN = require('resolve-alpn');
const QuickLRU = require('quick-lru');
const Http2ClientRequest = require('./client-request');
const calculateServerName = require('./utils/calculate-server-name');
const urlToOptions = require('./utils/url-to-options');

const cache = new QuickLRU({maxSize: 100});

const resolveProtocol = async options => {
	const name = `${options.host}:${options.port}:${options.ALPNProtocols.sort()}`;

	if (!cache.has(name)) {
		const result = (await resolveALPN(options)).alpnProtocol;
		cache.set(name, result);

		return result;
	}

	return cache.get(name);
};

module.exports = async (input, options, callback) => {
	if (typeof input === 'string' || input instanceof URL) {
		input = urlToOptions(new URL(input));
	}

	if (typeof options === 'function') {
		callback = options;
	}

	options = {
		ALPNProtocols: ['h2', 'http/1.1'],
		protocol: 'https:',
		...input,
		...options,
		resolveSocket: false
	};

	options.host = options.hostname || options.host || 'localhost';
	options.session = options.tlsSession;
	options.servername = options.servername || calculateServerName(options);

	if (options.protocol === 'https:') {
		options.port = options.port || 443;

		const {path} = options;
		options.path = options.socketPath;

		const protocol = await resolveProtocol(options);

		options.path = path;

		if (protocol === 'h2') {
			if (options.agent && options.agent.http2) {
				options.agent = options.agent.http2;
			}

			return new Http2ClientRequest(options, callback);
		}

		if (protocol === 'http/1.1') {
			if (options.agent && options.agent.https) {
				options.agent = options.agent.https;
			}

			options._defaultAgent = https.globalAgent;

			return http.request(options, callback);
		}

		throw new Error('Unknown ALPN protocol');
	}

	options.port = options.port || 80;

	if (options.agent && options.agent.http) {
		options.agent = options.agent.http;
	}

	options._defaultAgent = http.globalAgent;

	return http.request(options, callback);
};

module.exports.protocolCache = cache;
