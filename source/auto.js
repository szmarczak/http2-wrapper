'use strict';
// See https://github.com/facebook/jest/issues/2549
// eslint-disable-next-line node/prefer-global/url
const {URL} = require('url');
const http = require('http');
const https = require('https');
const resolveALPN = require('resolve-alpn');
const QuickLRU = require('quick-lru');
const {Agent, globalAgent} = require('./agent');
const Http2ClientRequest = require('./client-request');
const calculateServerName = require('./utils/calculate-server-name');
const urlToOptions = require('./utils/url-to-options');

const cache = new QuickLRU({maxSize: 100});
const queue = new Map();

const installSocket = (agent, socket, options) => {
	socket._httpMessage = {shouldKeepAlive: true};

	const onFree = () => {
		agent.emit('free', socket, options);
	};

	socket.on('free', onFree);

	const onClose = () => {
		agent.removeSocket(socket, options);
	};

	socket.on('close', onClose);

	const onTimeout = () => {
		const {freeSockets} = agent;

		for (const sockets of Object.values(freeSockets)) {
			if (sockets.includes(socket)) {
				socket.destroy();
				return;
			}
		}
	};

	socket.on('timeout', onTimeout);

	const onRemove = () => {
		agent.removeSocket(socket, options);
		socket.off('close', onClose);
		socket.off('free', onFree);
		socket.off('timeout', onTimeout);
		socket.off('agentRemove', onRemove);
	};

	socket.on('agentRemove', onRemove);

	agent.emit('free', socket, options);
};

const resolveProtocol = async options => {
	const name = `${options.host}:${options.port}:${options.ALPNProtocols.sort()}`;

	if (!cache.has(name)) {
		if (queue.has(name)) {
			const result = await queue.get(name);
			return {alpnProtocol: result.alpnProtocol};
		}

		const {path} = options;
		options.path = options.socketPath;

		const resultPromise = resolveALPN(options);
		queue.set(name, resultPromise);

		try {
			const result = await resultPromise;

			cache.set(name, result.alpnProtocol);
			queue.delete(name);

			options.path = path;

			return result;
		} catch (error) {
			queue.delete(name);

			options.path = path;

			throw error;
		}
	}

	return {alpnProtocol: cache.get(name)};
};

module.exports = async (input, options, callback) => {
	if (typeof input === 'string' || input instanceof URL) {
		input = urlToOptions(new URL(input));
	}

	if (typeof options === 'function') {
		callback = options;
		options = undefined;
	}

	options = {
		ALPNProtocols: ['h2', 'http/1.1'],
		...input,
		...options
	};

	if (!Array.isArray(options.ALPNProtocols) || options.ALPNProtocols.length === 0) {
		throw new Error('The `ALPNProtocols` option must be an Array with at least one entry');
	}

	options.protocol = options.protocol || 'https:';
	const isHttps = options.protocol === 'https:';

	options.host = options.hostname || options.host || 'localhost';
	options.session = options.tlsSession;
	options.servername = options.servername || calculateServerName(options);
	options.port = options.port || (isHttps ? 443 : 80);
	options._defaultAgent = isHttps ? https.globalAgent : http.globalAgent;

	// Note: We don't support `h2session` here

	let {agent} = options;
	if (agent !== false && agent !== undefined && (typeof agent !== 'object' || Object.getPrototypeOf(agent) !== Object.prototype)) {
		throw new Error('The `options.agent` can be only an object `http`, `https` or `http2` properties');
	}

	if (isHttps) {
		options.resolveSocket = true;

		let {socket, alpnProtocol} = await resolveProtocol(options);

		if (socket && options.createConnection) {
			socket.destroy();
			socket = undefined;
		}

		delete options.resolveSocket;

		const isH2 = alpnProtocol === 'h2';

		if (agent) {
			agent = isH2 ? agent.http2 : agent.https;
			options.agent = agent;
		} else if (agent === undefined) {
			agent = isH2 ? globalAgent : https.globalAgent;
		}

		if (socket) {
			if (agent === false) {
				socket.destroy();
			} else {
				const defaultCreateConnection = (isH2 ? Agent : https.Agent).prototype.createConnection;

				if (agent.createConnection === defaultCreateConnection) {
					if (isH2) {
						options._reuseSocket = socket;
					} else {
						installSocket(agent, socket, options);
					}
				} else {
					socket.destroy();
				}
			}
		}

		if (isH2) {
			return new Http2ClientRequest(options, callback);
		}
	} else if (agent) {
		options.agent = agent.http;
	}

	return http.request(options, callback);
};

module.exports.protocolCache = cache;
module.exports.resolveProtocol = resolveProtocol;
