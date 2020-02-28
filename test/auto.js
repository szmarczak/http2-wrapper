const tls = require('tls');
const https = require('https');
const http = require('http');
const util = require('util');
// eslint-disable-next-line ava/use-test
const {serial: test, afterEach} = require('ava');
const pEvent = require('p-event');
const getStream = require('get-stream');
const createCert = require('create-cert');
const http2 = require('../source');
const {createServer} = require('./helpers/server');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

test.serial = test;
afterEach(() => {
	http2.globalAgent.destroy();
});

const createH1Server = () => {
	const server = http.createServer((request, response) => {
		response.end('http/1.1');
	});

	server.listen = util.promisify(server.listen);
	server.close = util.promisify(server.close);

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
});

test.after('cleanup', async () => {
	await h1s.close();
	await h2s.close();
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
	t.is(Object.keys(agent.freeSessions).length, 1);

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

test('accepts string as URL', async t => {
	const request = await http2.auto(h2s.url);
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'h2');
});

test('the default protocol is `https:`', async t => {
	const request = await http2.auto({
		hostname: 'localhost',
		port: h2s.address().port
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'h2');
});

test('default port for `http:` protocol is 80', async t => {
	const request = await http2.auto({
		protocol: 'http:',
		hostname: 'localhost'
	});

	const error = await pEvent(request, 'error');
	t.is(error.address, '127.0.0.1');
	t.is(error.port, 80);
});

test('default port for `https:` protocol is 443', async t => {
	const error = await t.throwsAsync(http2.auto({
		protocol: 'https:',
		hostname: 'localhost'
	}));

	t.is(error.address, '127.0.0.1');
	t.is(error.port, 443);
});

test('passes http/2 errors', async t => {
	await t.throwsAsync(http2.auto(h2s.url, {
		auth: 1
	}), {
		message: /Received type number/
	});
});

// This needs to run first, because the cache is shared between the tests.
test.serial('reuses protocol cache for https requests', async t => {
	http2.auto.protocolCache.clear();

	await t.notThrowsAsync(http2.auto(h2s.url));
	await t.notThrowsAsync(http2.auto(h2s.url));

	t.is(http2.auto.protocolCache.size, 1);
});

test.serial('cache hostname defaults to `localhost`', async t => {
	http2.auto.protocolCache.clear();

	const request = await http2.auto({
		protocol: 'https:',
		port: h2s.options.port
	});
	request.end();

	await pEvent(request, 'response');
	request.abort();

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
				allowHalfOpen: true,
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

const cb = fn => {
	return (t, ...args) => new Promise((resolve, reject) => {
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
};

test('callback as a second argument', cb(async t => {
	await t.notThrowsAsync((async () => {
		const request = await http2.auto(h2s.url, response => {
			response.req.abort();
			t.end();
		});

		request.end();
	})());
}));

test('defaults to HTTP1 if no ALPN protocol', async t => {
	const keys = await createCert();

	const server = await tls.createServer(keys, socket => {
		socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhttps');
	});

	server.listen = util.promisify(server.listen);
	server.close = util.promisify(server.close);

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
	request.abort();
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
	request.abort();

	agent.destroy();
});

test.serial('reuses HTTP/1.1 TLS sockets #2', async t => {
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

		agent.prependOnceListener('free', socket => {
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

	const [a, b] = await Promise.all([http2.auto(h2s.url, options), http2.auto(h2s.url, options)]);

	a.abort();
	b.abort();

	t.is(socketCount, 1);
});

test.serial('does not reuse HTTP/1.1 TLS sockets if custom `createConnection` option is present', async t => {
	http2.auto.protocolCache.clear();

	const agent = new https.Agent({keepAlive: true});

	agent.prependOnceListener('free', () => {
		t.fail('free event emitted');
	});

	const options = {
		agent: {
			https: agent
		},
		createConnection: tls.connect,
		ALPNProtocols: ['http/1.1']
	};

	const request = await http2.auto(h2s.url, options);
	request.abort();

	t.pass();
});

test('http2 works (Internet connection)', async t => {
	const request = await http2.auto('https://httpbin.org/anything');
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	t.is(response.headers[':status'], 200);
});
