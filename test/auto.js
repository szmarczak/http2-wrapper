const tls = require('tls');
const https = require('https');
const http = require('http');
const {promisify} = require('util');
// eslint-disable-next-line ava/use-test
const {serial: test, afterEach} = require('ava');
const pEvent = require('p-event');
const getStream = require('get-stream');
const http2 = require('../source/index.js');
const delayAsyncDestroy = require('../source/utils/delay-async-destroy.js');
const {createServer} = require('./helpers/server.js');
const {key, cert} = require('./helpers/certs.js');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

test.serial = test;
afterEach(() => {
	http2.globalAgent.destroy();
});

const createH1Server = () => {
	const server = http.createServer((request, response) => {
		response.end('http/1.1');
	});

	server.listen = promisify(server.listen);
	server.close = promisify(server.close);

	return server;
};

let h1s;
let h2s;

test.before('setup', async () => {
	h1s = createH1Server();
	h2s = await createServer();

	h2s.get('/', (request, response) => {
		const session = request.httpVersion === '2.0' ? request.stream.session : request;
		response.end(session.socket.alpnProtocol);
	});

	await h1s.listen();
	await h2s.listen();

	h1s.url = `http://localhost:${h1s.address().port}`;

	h1s.unref();
	h2s.unref();
});

test.after('cleanup', async () => {
	await h1s.close();
	await h2s.close();
});

test('http2 via ip', async t => {
	const request = await http2.auto({
		protocol: 'https:',
		hostname: '127.0.0.1',
		port: h2s.address().port
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'h2');
});

test('http2', async t => {
	const request = await http2.auto({
		protocol: 'https:',
		hostname: 'localhost',
		port: h2s.address().port
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'h2');
});

test('http2 agent', async t => {
	const agent = new http2.Agent();

	const request = await http2.auto({
		protocol: 'https:',
		hostname: 'localhost',
		port: h2s.address().port,
		agent: {
			http2: agent
		}
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'h2');

	// This is 1 instead of 0 because of `delayAsyncDestroy`.
	t.is(agent.pendingSessionCount, 1);

	agent.destroy();
});

test('https', async t => {
	const request = await http2.auto({
		protocol: 'https:',
		hostname: 'localhost',
		port: h2s.address().port,
		ALPNProtocols: ['http/1.1']
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'http/1.1');
});

test('https with http2 headers', async t => {
	const request = await http2.auto({
		protocol: 'https:',
		hostname: 'localhost',
		port: h2s.address().port,
		ALPNProtocols: ['http/1.1'],
		headers: {
			':method': 'GET',
			':scheme': 'https',
			':authority': `localhost:${h2s.address().port}`,
			':path': '/'
		}
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'http/1.1');
});

test('https agent', async t => {
	const agent = new https.Agent();

	const request = await http2.auto({
		protocol: 'https:',
		hostname: 'localhost',
		port: h2s.address().port,
		ALPNProtocols: ['http/1.1'],
		agent: {
			https: agent
		}
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'http/1.1');
	t.is(Object.keys(agent.sockets).length, 1);

	agent.destroy();
});

test('http', async t => {
	const request = await http2.auto({
		protocol: 'http:',
		hostname: 'localhost',
		port: h1s.address().port
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'http/1.1');
});

test('http agent', async t => {
	const agent = new http.Agent();

	const request = await http2.auto({
		protocol: 'http:',
		hostname: 'localhost',
		port: h1s.address().port,
		agent: {
			http: agent
		}
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'http/1.1');
	t.is(Object.keys(agent.sockets).length, 1);

	agent.destroy();
});

test('accepts a URL instance as input', async t => {
	const request = await http2.auto(new URL(h2s.url));
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'h2');
});

test('accepts string as input', async t => {
	const request = await http2.auto(h2s.url);
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'h2');
});

test('the default protocol is `https:`', async t => {
	{
		const request = await http2.auto({
			hostname: 'localhost',
			port: h2s.address().port
		});
		request.end();

		const response = await pEvent(request, 'response');
		const data = await getStream(response);
		t.is(data, 'h2');
	}

	{
		const request = await http2.auto({
			hostname: 'localhost',
			port: h2s.address().port,
			protocol: undefined
		});
		request.end();

		const response = await pEvent(request, 'response');
		const data = await getStream(response);
		t.is(data, 'h2');
	}
});

test('default port for `http:` protocol is 80', async t => {
	t.plan(3);

	const message = 'Oh, snap!';
	const request = await http2.auto({
		protocol: 'http:',
		hostname: 'localhost',
		createConnection: (options, callback) => {
			t.is(options.port, 80);
			t.is(options.host, 'localhost');

			callback(new Error(message));
		}
	});

	await t.throwsAsync(pEvent(request, 'anyOtherEvent'), {
		message
	});
});

test('default port for `https:` protocol is 443', async t => {
	const error = await t.throwsAsync(http2.auto({
		protocol: 'https:',
		hostname: 'localhost'
	}));

	t.true(error.address === '127.0.0.1' || error.address === '::1');
	t.is(error.port, 443);
});

test('passes http/2 errors', async t => {
	await t.throwsAsync(http2.auto(h2s.url, {
		auth: 1
	}), {
		message: /Received type number/
	});
});

test.serial('reuses protocol cache for https requests', async t => {
	http2.auto.protocolCache.clear();

	const first = await http2.auto(h2s.url);
	const second = await http2.auto(h2s.url);

	t.is(http2.auto.protocolCache.size, 1);

	first.destroy();
	second.destroy();
});

test.serial('cache hostname defaults to `localhost`', async t => {
	http2.auto.protocolCache.clear();

	const request = await http2.auto({
		protocol: 'https:',
		port: h2s.options.port
	});
	request.end();

	await pEvent(request, 'response');
	request.destroy();

	const key = `localhost:${h2s.options.port}:h2,http/1.1`;

	t.is(http2.auto.protocolCache.get(key), 'h2');
});

test('passes http/1 errors', async t => {
	await t.throwsAsync(http2.auto(h1s.url, {
		headers: {
			foo: undefined
		}
	}), {
		message: 'Invalid value "undefined" for header "foo"'
	});
});

test('`host` option is an alternative to `hostname` option', async t => {
	const request = await http2.auto({
		protocol: 'https:',
		host: 'localhost',
		port: h2s.address().port
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'h2');
});

test('does not break when using `createConnection` option', async t => {
	let called = false;

	const request = await http2.auto({
		protocol: 'https:',
		hostname: 'localhost',
		port: h2s.address().port,
		createConnection: (_authority, options) => {
			called = true;

			return tls.connect(h2s.address().port, 'localhost', {
				...options,
				servername: 'localhost',
				ALPNProtocols: ['h2']
			});
		},
		agent: false
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'h2');
	t.true(called);

	request.agent.destroy();
});

const cb = fn =>
	(t, ...args) => new Promise((resolve, reject) => {
		let calledEnd = false;

		const tProxy = new Proxy(t, {
			get: (target, property) => {
				if (property === 'end') {
					return error => {
						if (calledEnd) {
							t.fail('`t.end()` called more than once');
							return;
						}

						calledEnd = true;

						if (error) {
							reject(error);
						} else {
							resolve();
						}
					};
				}

				return target[property];
			}
		});

		fn(tProxy, ...args);
	});

test('callback as a second argument', cb(async t => {
	await t.notThrowsAsync((async () => {
		const request = await http2.auto(h2s.url, response => {
			response.req.destroy();
			t.end();
		});

		request.end();
	})());
}));

test('defaults to HTTP1 if no ALPN protocol', async t => {
	const server = await tls.createServer({key, cert}, socket => {
		socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhttps');
	});

	server.listen = promisify(server.listen);
	server.close = promisify(server.close);

	await server.listen();

	const url = `https://localhost:${server.address().port}`;

	await t.notThrowsAsync(async () => {
		const request = await http2.auto(url);
		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(body, 'https');
	});

	await server.close();
});

test('invalid `agent` option', async t => {
	await t.throwsAsync(http2.auto('https://example.com', {
		agent: new https.Agent()
	}));
});

test.serial('reuses HTTP/1.1 TLS sockets', async t => {
	http2.auto.protocolCache.clear();

	const agent = new https.Agent({keepAlive: true});

	agent.createSocket = () => {
		throw new Error('Socket not reused');
	};

	agent.prependOnceListener('free', socket => {
		t.true(socket._httpMessage.shouldKeepAlive);
	});

	const options = {
		agent: {
			https: agent
		},
		ALPNProtocols: ['http/1.1']
	};

	const request = await http2.auto(h2s.url, options);
	request.destroy();

	// Who has invented `socket hang up` on client destroy? Useless.
	request.once('error', () => {});
});

test.serial('sets agent timeout on reused HTTP/1.1 TLS sockets', async t => {
	http2.auto.protocolCache.clear();

	const agent = new https.Agent({
		keepAlive: true,
		timeout: 10
	});

	agent.createSocket = () => {
		throw new Error('Socket not reused');
	};

	agent.prependOnceListener('free', socket => {
		t.true(socket._httpMessage.shouldKeepAlive);
	});

	const options = {
		agent: {
			https: agent
		},
		ALPNProtocols: ['http/1.1']
	};

	const request = await http2.auto(h2s.url, options);

	await pEvent(request, 'timeout');
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	const endPromise = pEvent(response, 'end');

	await pEvent(agent, 'free');
	await endPromise;
});

test.serial('reuses HTTP/1.1 TLS sockets - agentRemove works', async t => {
	http2.auto.protocolCache.clear();

	const agent = new https.Agent({keepAlive: true});

	agent.createSocket = () => {
		throw new Error('Socket not reused');
	};

	agent.prependOnceListener('free', socket => {
		t.true(socket._httpMessage.shouldKeepAlive);

		socket.emit('agentRemove');

		t.is(socket.listenerCount('agentRemove'), 0);
	});

	const options = {
		agent: {
			https: agent
		},
		ALPNProtocols: ['http/1.1']
	};

	const request = await http2.auto(h2s.url, options);
	request.destroy();

	// Who has invented `socket hang up` on client destroy? Useless.
	request.once('error', () => {});

	agent.destroy();
});

test.serial('reuses HTTP/1.1 TLS sockets #2', async t => {
	t.plan(4);

	http2.auto.protocolCache.clear();

	let socketCount = 0;

	const agent = new https.Agent({keepAlive: true});
	const createSocket = agent.createSocket.bind(agent);

	agent.createSocket = (...args) => {
		socketCount++;

		return createSocket(...args);
	};

	agent.prependOnceListener('free', socket => {
		t.true(socket._httpMessage.shouldKeepAlive);

		agent.once('free', socket => {
			t.is(socket._httpMessage, null);
			t.is(socket.alpnProtocol, 'http/1.1');
		});
	});

	const options = {
		agent: {
			https: agent
		},
		ALPNProtocols: ['http/1.1']
	};

	const [a, b] = await Promise.all([
		http2.auto(h2s.url, options),
		http2.auto(h2s.url, options)
	]);

	a.end();
	b.end();

	const [responseA, responseB] = await Promise.all([
		pEvent(a, 'response'),
		pEvent(b, 'response')
	]);

	responseA.resume();
	responseB.resume();

	await Promise.all([
		pEvent(responseA, 'end'),
		pEvent(responseB, 'end')
	]);

	t.is(socketCount, 1);

	agent.destroy();
});

test.serial('does not reuse sockets if agent has custom createConnection()', async t => {
	http2.auto.protocolCache.clear();

	const agent = new https.Agent({keepAlive: true});
	const createConnection = agent.createConnection.bind(agent);

	agent.createConnection = (...args) => {
		t.pass();

		return createConnection(...args);
	};

	const options = {
		agent: {
			https: agent
		},
		ALPNProtocols: ['http/1.1']
	};

	const request = await http2.auto(h2s.url, options);
	await pEvent(request, 'socket');

	request.destroy();

	// Who has invented `socket hang up` on client destroy? Useless.
	request.once('error', () => {});
});

test.serial('does not reuse HTTP/1.1 TLS sockets if the `createConnection` option is present', async t => {
	http2.auto.protocolCache.clear();

	const {createConnection} = https.globalAgent;
	https.globalAgent.createConnection = () => {};

	const kIsOriginal = Symbol('isOriginal');

	let calls = 0;

	tls._connect = tls.connect;
	tls.connect = (...args) => {
		calls++;

		return tls._connect(...args);
	};

	const options = {
		createConnection: (...args) => {
			const socket = tls.connect(...args);

			socket[kIsOriginal] = true;

			return socket;
		},
		ALPNProtocols: ['http/1.1']
	};

	const request = await http2.auto(h2s.url, options);
	await pEvent(request, 'socket');

	t.true(request.socket[kIsOriginal]);
	t.is(calls, 2);

	https.globalAgent.createConnection = createConnection;
	tls.connect = tls._connect;
	request.destroy();

	// Who has invented `socket hang up` on client destroy? Useless.
	request.once('error', () => {});
});

test('http2 works (Internet connection)', async t => {
	const request = await http2.auto('https://httpbin.org/anything');
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	t.is(response.headers[':status'], 200);
});

test('throws when ALPNProtocols is invalid', async t => {
	await t.throwsAsync(http2.auto({
		ALPNProtocols: 1
	}), {
		message: 'The `ALPNProtocols` option must be an Array with at least one entry'
	});

	await t.throwsAsync(http2.auto({
		ALPNProtocols: []
	}), {
		message: 'The `ALPNProtocols` option must be an Array with at least one entry'
	});
});

test('throws on invalid agent option', async t => {
	await t.throwsAsync(http2.auto({
		agent: https.globalAgent
	}), {
		message: 'The `options.agent` can be only an object `http`, `https` or `http2` properties'
	});
});

test.serial('does not reuse if agent is false', async t => {
	http2.auto.protocolCache.clear();

	const options = {
		agent: false,
		ALPNProtocols: ['http/1.1']
	};

	const request = await http2.auto(h2s.url, options);
	await pEvent(request, 'socket');

	t.is(Object.values(https.globalAgent.sockets).length, 0);

	request.destroy();

	// Who has invented `socket hang up` on client destroy? Useless.
	request.once('error', () => {});
});

test.serial('reuses HTTP/2 TLS sockets', async t => {
	http2.auto.protocolCache.clear();

	const agent = new http2.Agent();

	let counter = 0;

	tls._connect = tls.connect;
	tls.connect = (...args) => {
		counter++;
		return tls._connect(...args);
	};

	const options = {
		agent: {
			http2: agent
		},
		ALPNProtocols: ['h2']
	};

	const request = await http2.auto(h2s.url, options);
	request.end();

	const response = await pEvent(request, 'response');
	const body = await getStream(response);

	t.is(body, 'h2');

	tls.connect = tls._connect;
	delete tls._connect;

	agent.destroy();

	t.is(counter, 1);
	t.pass();
});

test.serial('Node.js native - HTTP/2 - reuse a socket that has already buffered some data', async t => {
	t.plan(1);

	const server = await createServer();
	await server.listen();

	const options = {
		ALPNProtocols: ['h2'],
		host: '127.0.0.1',
		servername: 'localhost',
		port: server.options.port
	};

	await new Promise(resolve => {
		const socket = tls.connect(options, async () => {
			await new Promise(resolve => {
				setTimeout(resolve, 1000);
			});

			const session = http2.connect(`https://localhost:${server.options.port}`, {
				createConnection: () => socket
			});

			session.once('remoteSettings', () => {
				t.pass();
				resolve();

				session.close();
			});

			session.once('error', () => {
				t.fail('Session errored');
				resolve();
			});
		});
	});

	await server.close();
});

test.serial('creates a new socket on early socket close by the server', async t => {
	http2.auto.protocolCache.clear();

	const server = await createServer();
	await server.listen();

	server.get('/', (request, response) => {
		response.end('hello world');
	});

	let count = 0;

	let first = true;
	server.on('secureConnection', socket => {
		count++;

		if (first) {
			socket.end();

			first = false;
		}
	});

	const request = await http2.auto(server.url);

	await new Promise(resolve => {
		setTimeout(resolve, 20);
	});

	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	t.is(count, 2);

	http2.globalAgent.destroy();

	await server.close();
});

test.serial('creates a new socket on early socket close by the server 2', async t => {
	http2.auto.protocolCache.clear();

	const server = await createServer();
	await server.listen();

	server.on('secureConnection', socket => {
		socket.setTimeout(50);

		socket.once('timeout', () => {
			socket.destroy();
		});
	});

	server.get('/', (request, response) => {
		response.end('hello world');
	});

	const request = await http2.auto(server.url);
	await new Promise(resolve => {
		setTimeout(resolve, 200);
	});
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	t.pass();

	http2.globalAgent.destroy();

	await server.close();
});

test('does not throw when passing agents as `undefined`', async t => {
	const options = {
		agent: {
			http2: undefined
		}
	};

	const request = await http2.auto(h2s.url, options);
	request.destroy();

	t.pass();
});

test('throws on timeout', async t => {
	t.timeout(100);

	await t.throwsAsync(http2.auto('https://123.123.123.123', {timeout: 1}), {
		message: 'Timed out resolving ALPN: 1 ms',
		code: 'ETIMEDOUT'
	});
});

test.serial('custom resolveProtocol with custom agent', async t => {
	http2.auto.protocolCache.clear();

	const server = await createServer();
	await server.listen();

	let count = 0;

	server.on('connection', () => {
		count++;
	});

	class CustomAgent extends http2.Agent {
		createConnection(origin, options) {
			return http2.Agent.connect(origin, options);
		}
	}

	const agent = new CustomAgent();

	const request = await http2.auto(server.url, {
		agent: {
			http2: agent
		},
		resolveProtocol: () => ({alpnProtocol: 'h2'})
	});
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	t.is(count, 1);
	agent.destroy();

	await server.close();
});

test.serial('custom async resolveProtocol with custom agent', async t => {
	http2.auto.protocolCache.clear();

	const server = await createServer();
	await server.listen();

	let count = 0;

	server.on('connection', () => {
		count++;
	});

	class CustomAgent extends http2.Agent {
		createConnection(origin, options) {
			return http2.Agent.connect(origin, options);
		}
	}

	const agent = new CustomAgent();

	const request = await http2.auto(server.url, {
		agent: {
			http2: agent
		},
		resolveProtocol: async () => ({alpnProtocol: 'h2'})
	});
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	t.is(count, 1);
	agent.destroy();

	await server.close();
});

test.serial('create resolve protocol function', async t => {
	http2.auto.protocolCache.clear();

	const server = await createServer();
	await server.listen();

	let count = 0;

	server.on('connection', () => {
		count++;
	});

	class CustomAgent extends http2.Agent {
		createConnection(origin, options) {
			return http2.Agent.connect(origin, options);
		}
	}

	const agent = new CustomAgent();

	const cache = new Map();

	const request = await http2.auto(server.url, {
		agent: {
			http2: agent
		},
		resolveProtocol: http2.auto.createResolveProtocol(cache)
	});
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	t.is(count, 2);
	t.is(cache.size, 1);
	agent.destroy();

	await server.close();
});

test.cb('no uncaught socket hang up error', t => {
	process.nextTick(async () => {
		const request = await http2.auto('http://example.com', {
			createConnection: (_options, callback) => {
				callback(new Error('oh no'));
			}
		});

		const error = await pEvent(request, 'error');
		t.is(error.message, 'oh no');

		t.end();
	});
});

test.cb('delayAsyncDestroy does not modify streams with error listeners', t => {
	let called = false;

	const request = http.request(h1s.url);
	request.once('error', () => {
		called = true;
	});
	request.destroy();

	delayAsyncDestroy(request);

	process.nextTick(() => {
		t.true(called);

		t.end();
	});
});
