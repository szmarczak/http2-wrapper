'use strict';
const net = require('net');
const http2 = require('http2');
const util = require('util');
const createCert = require('create-cert');

const delay = ms => new Promise(resolve => setTimeout(setImmediate, ms, resolve));

const createPlainServer = async (options, handler) => {
	if (typeof options === 'function') {
		handler = options;
	}

	const {key, cert} = await createCert();

	const server = http2.createSecureServer({cert, key, allowHTTP1: true, ...options}, handler);

	server.listen = util.promisify(server.listen);
	server.close = util.promisify(server.close);

	server.options = {
		hostname: 'localhost',
		protocol: 'https:'
	};

	server.once('listening', () => {
		server.options.port = server.address().port;
		server.url = `${server.options.protocol}//${server.options.hostname}:${server.options.port}`;
	});

	const sessions = [];
	let hasConnected = false;

	server.on('session', session => {
		hasConnected = true;
		sessions.push(session);

		session.once('close', () => {
			sessions.splice(sessions.indexOf(session), 1);
		});

		session.setTimeout(1000);
	});

	server.gracefulClose = async () => {
		let elapsed = 0;
		const tick = 10;

		// eslint-disable-next-line no-unmodified-loop-condition
		while ((sessions.length !== 0 || !hasConnected) && elapsed < 1000) {
			await delay(tick); // eslint-disable-line no-await-in-loop
			elapsed += tick;
		}

		return server.close();
	};

	return server;
};

const createProxyServer = async options => {
	const proxy = await createPlainServer(options);

	proxy.on('stream', (stream, headers) => {
		if (headers[':method'] !== 'CONNECT') {
			// Only accept CONNECT requests
			stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
			return;
		}

		const auth = new URL(`tcp://${headers[':authority']}`);
		const socket = net.connect(auth.port, auth.hostname, () => {
			stream.respond();
			socket.pipe(stream);
			stream.pipe(socket);
		});

		socket.on('error', () => {
			stream.close(http2.constants.NGHTTP2_CONNECT_ERROR);
		});
	});

	return proxy;
};

const createServer = async options => {
	const onRequest = (request, response) => {
		const body = [];

		request.on('data', chunk => body.push(chunk));
		request.on('end', () => {
			response.end(JSON.stringify({
				headers: request.headers,
				body: Buffer.concat(body).toString()
			}));
		});
	};

	const handlers = {
		get: {
			'/': onRequest
		},
		post: {
			'/': onRequest
		}
	};

	const server = await createPlainServer(options, (request, response) => {
		const methodHandlers = handlers[request.method.toLowerCase()];
		if (methodHandlers && methodHandlers[request.url]) {
			return methodHandlers[request.url](request, response);
		}
	});

	for (const method of Object.keys(handlers)) {
		server[method] = (path, fn) => {
			handlers[method][path] = fn;
		};
	}

	return server;
};

const createWrapper = options => {
	return async (t, run) => {
		const create = (options && options.createServer) || createServer;

		const server = await create(options);
		await server.listen();

		// Useful to fix uncaught exceptions:
		// console.log(`${server.options.port} - ${t.title}`);

		try {
			await run(t, server);
		} finally {
			await server.gracefulClose();
		}
	};
};

module.exports = {createServer, createProxyServer, createWrapper};
