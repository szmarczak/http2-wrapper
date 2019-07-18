'use strict';
const {URL} = require('url');
const http = require('http');
const https = require('https');
const QuickLRU = require('quick-lru');
const isCompatible = require('./utils/is-compatible');
const Http2ClientRequest = isCompatible ? require('./client-request') : undefined;
const httpResolveALPN = require('./utils/http-resolve-alpn');
const urlToOptions = require('./utils/url-to-options');

const cache = new QuickLRU({maxSize: 100});

const prepareRequest = async options => {
	if (options.protocol === 'https:') {
		const host = options.hostname || options.host || 'localhost';
		const port = options.port || 443;
		const ALPNProtocols = options.ALPNProtocols || ['h2', 'http/1.1'];
		const name = `${host}:${port}:${ALPNProtocols.sort()}`;

		let alpnProtocol = cache.get(name);

		if (typeof alpnProtocol === 'undefined') {
			alpnProtocol = (await httpResolveALPN(options)).alpnProtocol;
			cache.set(name, alpnProtocol);
		}

		if (alpnProtocol === 'h2' && isCompatible) {
			return (options, callback) => {
				if (options.agent && options.agent.http2) {
					options = {
						...options,
						agent: options.agent.http2
					};
				}

				return Http2ClientRequest.request(options, callback);
			};
		}

		return (options, callback) => {
			options = {
				...options,
				_defaultAgent: https.globalAgent,
				session: options.tlsSession
			};

			if (options.agent && options.agent.https) {
				options.agent = options.agent.https;
			}

			return http.request(options, callback);
		};
	}

	return (options, callback) => {
		options = {
			...options,
			_defaultAgent: http.globalAgent
		};

		if (options.agent && options.agent.http) {
			options.agent = options.agent.http;
		}

		return http.request(options, callback);
	};
};

module.exports = async (input, options, callback) => {
	if (typeof input === 'string' || input instanceof URL) {
		input = urlToOptions(new URL(input));
	}

	options = {
		protocol: 'https:',
		...input,
		...options
	};

	const request = await prepareRequest(options);

	return request(options, callback);
};

module.exports.resolveALPN = httpResolveALPN;
module.exports.prepareRequest = prepareRequest;
module.exports.protocolCache = cache;
