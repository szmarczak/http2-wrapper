'use strict';
const http = require('http');
const https = require('https');
const resolveALPN = require('resolve-alpn');
const QuickLRU = require('quick-lru');
const Http2ClientRequest = require('./client-request');
const {Agent, globalAgent: Http2GlobalAgent} = require('./agent');
const calculateServerName = require('./utils/calculate-server-name');
const urlToOptions = require('./utils/url-to-options');

const cache = new QuickLRU({maxSize: 100});
const queue = new Map();

const installSocket = (agent, socket, options) => {
	if (agent instanceof Agent) {
		agent._pushSocket(`https://${options.host}:${options.port}`, options, socket);
		return;
	}

	socket._httpMessage = {shouldKeepAlive: true};

	const onFree = () => {
		agent.emit('free', socket, options);
	};

	socket.on('free', onFree);

	const onClose = () => {
		agent.removeSocket(socket, options);
	};

	socket.on('close', onClose);

	const onRemove = () => {
		agent.removeSocket(socket, options);
		socket.off('close', onClose);
		socket.off('free', onFree);
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
			return result.alpnProtocol;
		}

		const {path, agent: agents} = options;
		options.path = options.socketPath;

		const resultPromise = resolveALPN(options);
		queue.set(name, resultPromise);

		try {
			const {socket, alpnProtocol} = await resultPromise;
			cache.set(name, alpnProtocol);

			socket.pause();

			options.path = path;

			const isHttp2 = alpnProtocol === 'h2';

			const globalAgent = isHttp2 ? Http2GlobalAgent : https.globalAgent;
			const defaultCreateConnection = isHttp2 ? Agent.prototype.createConnection : https.Agent.prototype.createConnection;

			if (agents || options.createConnection) {
				if (agents) {
					const agent = agents[isHttp2 ? 'http2' : 'https'];

					if (agent.createConnection === defaultCreateConnection) {
						installSocket(agent, socket, options);
					}
				} else {
					options.createConnection = () => socket;
				}
			} else if (globalAgent.createConnection === defaultCreateConnection) {
				installSocket(globalAgent, socket, options);
			} else {
				socket.destroy();
			}

			queue.delete(name);

			return alpnProtocol;
		} catch (error) {
			queue.delete(name);

			throw error;
		}
	}

	return cache.get(name);
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
		protocol: 'https:',
		...input,
		...options,
		resolveSocket: true
	};

	const isHttps = options.protocol === 'https:';
	const agents = options.agent;

	options.host = options.hostname || options.host || 'localhost';
	options.session = options.tlsSession;
	options.servername = options.servername || calculateServerName(options);
	options.port = options.port || (isHttps ? 443 : 80);
	options._defaultAgent = isHttps ? https.globalAgent : http.globalAgent;

	if (agents && (agents.addRequest || agents.request)) {
		throw new Error('The `options.agent` object can contain only `http`, `https` or `http2` properties');
	}

	if (isHttps) {
		const protocol = await resolveProtocol(options);

		if (protocol === 'h2') {
			if (agents) {
				options.agent = agents.http2;
			}

			return new Http2ClientRequest(options, callback);
		}

		if (agents) {
			options.agent = agents.https;
		}
	} else if (agents) {
		options.agent = agents.http;
	}

	return http.request(options, callback);
};

module.exports.protocolCache = cache;
