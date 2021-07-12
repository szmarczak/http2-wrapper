'use strict';
const net = require('net');
const http2 = require('http2');
const {promisify} = require('util');
const lolex = require('lolex');
const {key, cert} = require('./certs.js');

const createPlainServer = async (options, handler) => {
	if (typeof options === 'function') {
		handler = options;
	}

	const server = http2.createSecureServer({cert, key, allowHTTP1: true, ...options}, handler);

	server.listen = promisify(server.listen);
	server.close = promisify(server.close);

	server.options = {
		hostname: 'localhost',
		protocol: 'https:'
	};

	server.once('listening', () => {
		server.options.port = server.address().port;
		server.url = `${server.options.protocol}//${server.options.hostname}:${server.options.port}`;
	});

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
			const reply = JSON.stringify({
				headers: request.headers,
				body: Buffer.concat(body).toString()
			});

			response.end(reply);
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

const createPlainWrapper = options =>
	async (t, run) => {
		const create = (options && options.createServer) || createServer;

		const clock = options && options.lolex ? lolex.install() : lolex.createClock();

		const server = await create(options);
		await server.listen();

		// Useful to fix uncaught exceptions:
		// console.log(`${server.options.port} - ${t.title}`);

		try {
			await run(t, server, clock);
		} finally {
			if (options && options.beforeServerClose) {
				options.beforeServerClose();
			}

			clock.runAll();

			if (options && options.lolex) {
				clock.uninstall();
			}

			await server.close();
		}
	};

const createWrapper = options => {
	const wrapper = createPlainWrapper(options);
	wrapper.lolex = createPlainWrapper({...options, lolex: true});

	return wrapper;
};

module.exports = {createServer, createProxyServer, createWrapper};
