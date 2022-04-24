const {promisify} = require('util');
const EventEmitter = require('events');
const {pipeline, PassThrough} = require('stream');
const net = require('net');
// eslint-disable-next-line ava/use-test
const {serial: test} = require('ava');
const pEvent = require('p-event');
const getStream = require('get-stream');
const tempy = require('tempy');
const is = require('@sindresorhus/is');
const {request: makeRequest, get, constants, connect, Agent, globalAgent, createServer: createUnsecureServer} = require('../source/index.js');
const calculateServerName = require('../source/utils/calculate-server-name.js');
const {createWrapper, createServer, createProxyServer} = require('./helpers/server.js');

const delay = ms => new Promise(resolve => {
	setTimeout(resolve, ms);
});

test.serial = test;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const wrapper = createWrapper({
	beforeServerClose: () => globalAgent.destroy()
});

const proxyWrapper = createWrapper({
	createServer: createProxyServer,
	beforeServerClose: () => globalAgent.destroy()
});

const okHandler = (request, response) => {
	response.end('ok');
};

test('throws an error on invalid protocol', t => {
	t.throws(() => makeRequest('invalid://'), {
		message: 'Protocol "invalid:" not supported. Expected "https:"'
	});
});

test('does not modify options', t => {
	const inputs = [
		undefined,
		'https://example.com',
		new URL('https://example.com')
	];

	const noop = () => {};

	for (const input of inputs) {
		const originalOptions = {
			foo: 'bar'
		};

		const options = {
			...originalOptions
		};

		const request = input ? makeRequest(input, options, noop) : makeRequest(options, noop);
		request.destroy();

		t.deepEqual(options, originalOptions);
	}
});

test('accepts `URL` as the input parameter', wrapper, async (t, server) => {
	server.get('/200', okHandler);

	const request = makeRequest(new URL(`${server.url}/200`));
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'ok');
});

test('accepts `string` as the input parameter', wrapper, async (t, server) => {
	server.get('/200', okHandler);

	const request = makeRequest(`${server.url}/200`);
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'ok');
});

test('`method` property', wrapper, async (t, server) => {
	const request = makeRequest(server.url);
	t.is(request.method, 'GET');

	request.method = 'post';
	t.is(request.method, 'POST');

	request.method = 0;
	t.is(request.method, 'POST');

	request.destroy();
});

test('`protocol` property', wrapper, async (t, server) => {
	const request = makeRequest(server.url);
	t.is(request.protocol, 'https:');

	request.destroy();
});

test('`host` property', wrapper, async (t, server) => {
	server.get('/200', okHandler);

	const request = makeRequest({
		path: '/200',
		port: server.options.port
	});

	t.is(request.host, 'localhost');
	request.host = 'this will not be set';
	t.is(request.host, 'localhost');

	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'ok');
});

test('accepts `options` as the input parameter', wrapper, async (t, server) => {
	server.get('/200', okHandler);

	const request = makeRequest({
		...server.options,
		path: '/200'
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'ok');
});

test('accepts options when passing string as input', wrapper, async (t, server) => {
	const request = makeRequest(server.url, {
		headers: {
			foo: 'bar'
		}
	});
	request.end();

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(JSON.parse(data).headers.foo, 'bar');
});

test('callback', wrapper, async (t, server) => {
	server.get('/200', okHandler);

	let resolvePromise;
	const promise = new Promise(resolve => {
		resolvePromise = resolve;
	});

	const request = makeRequest(`${server.url}/200`, response => resolvePromise(response));
	request.end();

	const response = await promise;
	const data = await getStream(response);
	t.is(data, 'ok');
});

test('`response` event', wrapper, async (t, server) => {
	const request = makeRequest(server.url, {
		headers: {
			foo: 'bar'
		}
	});
	request.end();

	await pEvent(request, 'response');
	request.destroy();

	t.pass();
});

test('`get()` ends the request', wrapper, async (t, server) => {
	server.get('/200', okHandler);

	const request = get(`${server.url}/200`);

	const response = await pEvent(request, 'response');
	const data = await getStream(response);
	t.is(data, 'ok');
});

test('passes options to the original request', wrapper, async (t, server) => {
	const request = makeRequest({...server.options, rejectUnauthorized: true});
	request.end();

	const error = await pEvent(request, 'error');

	// We can get `The pending stream has been canceled (caused by: self signed certificate)` or `unable to verify the first certificate`
	t.true((/self signed certificate/).test(error.message) || error.message === 'unable to verify the first certificate' || error.message === 'certificate has expired');
});

test('`tlsSession` option', wrapper, async (t, server) => {
	const request = makeRequest(server.url, {tlsSession: 'not a buffer', agent: false});
	request.end();

	const error = await pEvent(request, 'error');
	t.is(error.message, 'Session must be a buffer');
});

test('`auth` option', wrapper, async (t, server) => {
	const auth = 'foo:bar';

	const request = makeRequest(server.url, {auth});
	request.end();

	const response = await pEvent(request, 'response');
	const data = JSON.parse(await getStream(response));

	t.is(data.headers.authorization, `Basic ${Buffer.from(auth).toString('base64')}`);
});

test('`h2session` option', wrapper, async (t, server) => {
	let called = false;

	const h2session = connect(`${server.options.protocol}//${server.options.hostname}:${server.options.port}`);
	h2session._request = h2session.request;
	h2session.request = (...args) => {
		called = true;
		return h2session._request(...args);
	};

	const request = makeRequest({...server.options, h2session});
	request.end();

	await pEvent(request, 'finish');
	request.destroy();
	h2session.close();

	t.false(request.reusedSocket);
	t.true(called);
});

test('`.reusedSocket` is `true` if using Agent', wrapper, async (t, server) => {
	const request = makeRequest(server.url, {agent: false});
	request.end();

	await pEvent(request, 'response');
	t.true(request.reusedSocket);

	request.destroy();
});

test('`aborted` property is `false` before aborting', wrapper, (t, server) => {
	const request = makeRequest(server.options);
	t.true(is.boolean(request.aborted));
	request.abort();
});

test('`aborted` property is `true` after aborting', wrapper, (t, server) => {
	const request = makeRequest(server.options);
	request.abort();

	t.true(request.aborted);
});

test('`socket`/`connection` property is an instance of `net.Socket`', wrapper, async (t, server) => {
	const request = makeRequest(server.options);
	request.end();

	const socket = await pEvent(request, 'socket');

	t.true(request.socket instanceof net.Socket);
	t.is(request.socket, request.connection);
	t.is(request.socket, socket);

	request.destroy();
});

test('`.write()` works', wrapper, async (t, server) => {
	const body = 'Hello, world!';

	const request = makeRequest({...server.options, method: 'POST'});
	request.write(body);
	request.end();

	const response = await pEvent(request, 'response');
	const data = JSON.parse(await getStream(response));

	t.is(data.body, body);
});

test('writing after flushing', wrapper, async (t, server) => {
	const body = 'Hello, world!';

	const request = makeRequest({...server.options, method: 'POST'});
	request.flushHeaders();
	await pEvent(request, 'socket');

	request.write(body);
	request.end();

	const response = await pEvent(request, 'response');
	const data = JSON.parse(await getStream(response));

	t.is(data.body, body);
});

test('`.end()` works', wrapper, async (t, server) => {
	const body = 'Hello, world!';
	let finished = false;

	const request = makeRequest({...server.options, method: 'POST'});
	request.end(body, () => {
		finished = true;
	});

	const response = await pEvent(request, 'response');
	const data = JSON.parse(await getStream(response));

	t.true(finished);
	t.is(data.body, body);
});

test('`headersSent` property is `false` before flushing headers', wrapper, (t, server) => {
	const request = makeRequest(server.options);
	t.false(request.headersSent);
	request.destroy();
});

test('`headersSent` is `true` after flushing headers', wrapper, async (t, server) => {
	const request = makeRequest(server.options);
	request.end();

	await pEvent(request, 'finish');
	t.true(request.headersSent);

	request.destroy();
});

test('errors when stream ends unexpectedly', wrapper, async (t, server) => {
	server.once('stream', stream => {
		stream.destroy();
	});

	const request = makeRequest(server.options);
	request.end();

	const error = await pEvent(request, 'error');
	t.is(error.message, 'The HTTP/2 stream has been early terminated');
});

test.serial('`timeout` option', wrapper.lolex, async (t, server, clock) => {
	server.get('/', () => {});

	const request = makeRequest({
		...server.options,
		timeout: 1
	});
	request.end();

	const promise = pEvent(request, 'timeout');
	clock.tick(1);

	await promise;
	request.destroy();

	t.pass();
});

test.serial('`.setTimeout()` works', wrapper.lolex, async (t, server, clock) => {
	server.get('/', () => {});

	const request = makeRequest(server.options);
	request.setTimeout(1);
	request.end();

	const promise = pEvent(request, 'timeout');
	clock.tick(1);

	await promise;
	request.destroy();

	t.pass();
});

test('default port for `https:` protocol is 443', async t => {
	const request = makeRequest({protocol: 'https:', hostname: 'localhost'});
	request.end();

	const error = await pEvent(request, 'error');
	const address = error.address || error.cause.address;
	const port = error.port || error.cause.port;

	t.true(address === '127.0.0.1' || address === '::1');
	t.is(port, 443);
});

test('throws on `http:` protocol', t => {
	t.throws(() => makeRequest({protocol: 'http:'}), {
		message: 'Protocol "http:" not supported. Expected "https:"'
	});
});

test('throws when acesssing `socket` after session destruction', wrapper, async (t, server) => {
	const h2session = connect(`${server.options.protocol}//${server.options.hostname}:${server.options.port}`);
	const request = makeRequest(server.options, {h2session});
	request.end();

	const response = await pEvent(request, 'response');

	// We cannot compare `response.socket` to `h2session.socket` directly,
	// as `response.socket` is a Proxy object.
	t.is(response.socket.address(), h2session.socket.address());

	request.destroy();
	h2session.close();

	await pEvent(response.socket, 'close');
	t.throws(() => response.socket.write);
});

test('doesn\'t close custom sessions', wrapper, (t, server) => {
	const h2session = connect(`${server.options.protocol}//${server.options.hostname}:${server.options.port}`);
	const request = makeRequest({...server.options, h2session});
	request.destroy();

	t.false(h2session.destroyed);
	h2session.close();
});

test('`connect` event - request.path modification', proxyWrapper, async (t, proxy) => {
	const tcp = net.createServer(s => s.end('hello')).listen(0);

	const request = makeRequest({
		...proxy.options,
		method: 'CONNECT',
		headers: {
			':authority': 'foobar'
		}
	});
	t.is(request.path, 'foobar');
	request.path = `localhost:${tcp.address().port}`;
	request.end();

	const response = await pEvent(request, 'connect');
	const stream = response.req._request;
	t.true(response.upgrade);

	t.false(stream.writableEnded);

	const data = await pEvent(stream, 'data');
	t.is(data.toString(), 'hello');

	await pEvent(stream, 'end');

	tcp.close();
});

test('`connect` event - host header', proxyWrapper, async (t, proxy) => {
	const tcp = net.createServer(s => s.end('hello')).listen(0);

	const request = makeRequest({
		...proxy.options,
		method: 'CONNECT',
		headers: {
			host: `localhost:${tcp.address().port}`
		}
	});
	t.is(request.path, `localhost:${tcp.address().port}`);
	request.end();

	const response = await pEvent(request, 'connect');
	const stream = response.req._request;
	t.true(response.upgrade);

	t.false(stream.writableEnded);

	const data = await pEvent(stream, 'data');
	t.is(data.toString(), 'hello');

	await pEvent(stream, 'end');

	tcp.close();
});

test('`connect` event', proxyWrapper, async (t, proxy) => {
	const tcp = net.createServer(s => s.end('hello')).listen(0);

	const request = makeRequest({
		...proxy.options,
		method: 'CONNECT',
		headers: {
			':authority': `localhost:${tcp.address().port}`
		}
	});
	t.is(request.path, `localhost:${tcp.address().port}`);
	request.end();

	const response = await pEvent(request, 'connect');
	const stream = response.req._request;
	t.true(response.upgrade);

	t.false(stream.writableEnded);

	const data = await pEvent(stream, 'data');
	t.is(data.toString(), 'hello');

	await pEvent(stream, 'end');

	tcp.close();
});

test('`connect` event - URL string', proxyWrapper, async (t, proxy) => {
	const tcp = net.createServer(s => s.end('hello')).listen(0);

	const request = makeRequest(proxy.url, {
		method: 'CONNECT',
		headers: {
			':authority': `localhost:${tcp.address().port}`
		}
	});
	t.is(request.path, `localhost:${tcp.address().port}`);
	request.end();

	const response = await pEvent(request, 'connect');
	const stream = response.req._request;
	t.true(response.upgrade);

	t.false(stream.writableEnded);

	const data = await pEvent(stream, 'data');
	t.is(data.toString(), 'hello');

	await pEvent(stream, 'end');

	tcp.close();
});

test('`connect` event - URL', proxyWrapper, async (t, proxy) => {
	const tcp = net.createServer(s => s.end('hello')).listen(0);

	const request = makeRequest(new URL(proxy.url), {
		method: 'CONNECT',
		headers: {
			':authority': `localhost:${tcp.address().port}`
		}
	});
	t.is(request.path, `localhost:${tcp.address().port}`);
	request.end();

	const response = await pEvent(request, 'connect');
	const stream = response.req._request;
	t.true(response.upgrade);

	t.false(stream.writableEnded);

	const data = await pEvent(stream, 'data');
	t.is(data.toString(), 'hello');

	await pEvent(stream, 'end');

	tcp.close();
});

test('`information` event', wrapper, async (t, server) => {
	server.on('stream', (stream, headers) => {
		if (headers[constants.HTTP2_HEADER_PATH] === '/102') {
			stream.additionalHeaders({
				[constants.HTTP2_HEADER_STATUS]: 102
			});
			stream.end('');
		}
	});

	const request = makeRequest(`${server.url}/102`);
	request.end();

	const {statusCode} = await pEvent(request, 'information');
	t.is(statusCode, 102);

	request.destroy();
});

test('destroys the request if no listener attached for `CONNECT` request', proxyWrapper, async (t, proxy) => {
	const events = new EventEmitter();
	const tcp = net.createServer(s => s.on('close', () => {
		events.emit('closed');
	})).listen(0);

	const request = makeRequest({
		...proxy.options,
		method: 'CONNECT',
		headers: {
			':authority': `localhost:${tcp.address().port}`
		}
	});
	request.end();

	await pEvent(events, 'closed');

	tcp.close();

	t.pass();
});

test('`.destroy(reason)` after ending the request', wrapper, async (t, server) => {
	const error = 'Simple error';

	const request = makeRequest(server.options);
	request.end();

	await pEvent(request, 'response');
	request.destroy(new Error(error));

	const {message} = await pEvent(request, 'error');
	t.is(message, error);
	t.true(request._request.destroyed);
	t.is(request.destroyed, true);
});

test('`.destroy(reason)` before ending the request', wrapper, async (t, server) => {
	const error = 'Simple error';

	const request = makeRequest(server.options);
	request.destroy(new Error(error));
	request.end();

	const {message} = await pEvent(request, 'error');
	t.is(message, error);
	t.is(request._request, undefined);
	t.is(request.destroyed, true);
});

test('`.destroy()` after ending the request', wrapper, async (t, server) => {
	const request = makeRequest(server.options);
	request.end();

	await pEvent(request, 'response');
	request.destroy();

	t.is(request.destroyed, true);
});

test('`.destroy()` before ending the request', wrapper, async (t, server) => {
	const request = makeRequest(server.options);
	request.destroy();
	request.end();

	t.is(request.destroyed, true);
});

test('destroyed session causes no request errors', wrapper, (t, server) => {
	const request = makeRequest(server.options);
	request.destroy();
	t.notThrows(() => request.end());
});

test('`.flushHeaders()` has no effect if `.abort()` had been run before', wrapper, (t, server) => {
	const request = makeRequest(server.options);
	request.abort();
	t.notThrows(() => request.flushHeaders());
});

test('aborting after flushing headers errors when the connection gets broken', wrapper, async (t, server) => {
	const request = makeRequest(server.options);
	request.flushHeaders();
	request.abort();

	{
		// It's also called after every test finishes, so we need to overwrite `.close()` for this one.
		const promise = server.close();
		server.close = () => promise;
	}

	const error = await pEvent(request, 'error');
	t.is(error.code, 'ECONNREFUSED');
});

test('`.abort()` works', wrapper, async (t, server) => {
	server.get('/', request => {
		request.once('end', () => {
			if (!request.aborted) {
				t.fail('A request has been made');
			}
		});
	});

	const request = makeRequest(server.options);
	request.flushHeaders();
	request.abort();

	await delay(100);

	t.true(request.aborted);
});

test('emits `abort` only once', wrapper, async (t, server) => {
	let aborts = 0;

	const request = makeRequest(server.options);
	request.on('abort', () => aborts++);
	request.abort();
	request.abort();

	await delay(100);

	t.is(aborts, 1);
});

test('`.setNoDelay()` doesn\'t throw', wrapper, (t, server) => {
	const request = makeRequest(server.options);
	request.end();

	t.notThrows(() => request.setNoDelay());

	request.destroy();
});

test('`.setSocketKeepAlive()` doesn\'t throw', wrapper, (t, server) => {
	const request = makeRequest(server.options);
	request.end();

	t.notThrows(() => request.setSocketKeepAlive());

	request.destroy();
});

test('`.maxHeadersCount` - getter', wrapper, async (t, server) => {
	const request = makeRequest(server.options);
	t.is(request.maxHeadersCount, undefined);
	request.end();

	await pEvent(request, 'response');

	t.true(is.number(request.maxHeadersCount));

	request.destroy();
});

test('`.maxHeadersCount` - empty setter', wrapper, async (t, server) => {
	const request = makeRequest(server.options);
	request.maxHeadersCount = 1;
	t.is(request.maxHeadersCount, undefined);
	request.end();

	await pEvent(request, 'response');

	request.maxHeadersCount = undefined;
	t.true(is.number(request.maxHeadersCount));

	request.destroy();
});

test('throws if making a request using a closed session', wrapper, async (t, server) => {
	const h2session = connect(server.url);
	h2session.destroy();

	t.throws(() => makeRequest({
		...server.options,
		h2session
	}), {
		message: 'The session has been closed already'
	});
});

test('`.path` returns the pseudo path header', t => {
	const request = makeRequest({
		headers: {
			[constants.HTTP2_HEADER_PATH]: '/foobar'
		}
	});
	request.destroy();

	t.is(request.path, '/foobar');
});

test('throws on invalid `agent` option', t => {
	t.throws(
		() => makeRequest({agent: 0}),
		{
			message: 'The "options.agent" property must be one of type http2wrapper.Agent-like Object, undefined or false. Received number'
		}
	);
});

test('uses `globalAgent` if `agent` is `null`', t => {
	const request = makeRequest({agent: null});
	t.is(request.agent, globalAgent);

	request.destroy();
});

test('uses `globalAgent` if `agent` is `undefined`', t => {
	const request = makeRequest({agent: undefined});
	t.is(request.agent, globalAgent);

	request.destroy();
});

test('the `createConnection` option works', wrapper, async (t, server) => {
	let called = false;

	const request = makeRequest(server.url, {
		createConnection: (...args) => {
			called = true;
			return Agent.connect(...args);
		}
	});
	request.end();

	await pEvent(request, 'response');
	request.destroy();

	t.true(called);

	request.agent.destroy();
});

test('sets proper `:authority` header', wrapper, async (t, server) => {
	server.on('session', session => {
		session.origin('https://example.com');
	});

	server.get('/', (request, response) => {
		response.end(request.headers[':authority']);
	});

	const agent = new Agent();
	await agent.getSession(server.url);

	const request = makeRequest('https://example.com', {agent}).end();
	const response = await pEvent(request, 'response');
	const body = await getStream(response);

	t.is(body, 'example.com');

	agent.destroy();
});

test('pipeline works', wrapper, async (t, server) => {
	const body = new PassThrough();
	body.end();

	const request = makeRequest(server.url);

	await promisify(pipeline)(body, request);

	t.false(request.aborted);
	t.false(request.destroyed);

	request.destroy();
});

test('endStream is true', wrapper, async (t, server) => {
	server.once('session', session => {
		session.once('stream', (stream, headers, flags) => {
			if (flags & constants.STREAM_OPTION_EMPTY_PAYLOAD) {
				stream.respond({
					[constants.HTTP2_HEADER_STATUS]: 200,
					[constants.HTTP2_HEADER_CONTENT_TYPE]: 'text/plain'
				});
				stream.end();
			} else {
				stream.respond({
					[constants.HTTP2_HEADER_STATUS]: 403,
					[constants.HTTP2_HEADER_CONTENT_TYPE]: 'text/plain'
				});
				stream.end();
			}
		});
	});

	const request = makeRequest(server.url).end();
	const response = await pEvent(request, 'response');
	t.is(response.statusCode, 200);

	response.resume();
	await pEvent(response, 'end');
});

test('finish event for GET', wrapper, async (t, server) => {
	const request = makeRequest(server.options);
	request.end();

	await pEvent(request, 'finish');
	request.destroy();

	t.pass();
});

test('finish event for POST', wrapper, async (t, server) => {
	const request = makeRequest({
		...server.options,
		method: 'POST'
	});

	request.end();

	await pEvent(request, 'finish');
	request.destroy();

	t.pass();
});

test('throws when writing using GET, HEAD or DELETE', wrapper, async (t, server) => {
	const methods = ['GET', 'HEAD', 'DELETE'];
	const message = 'The GET, HEAD and DELETE methods must NOT have a body';

	for (const method of methods) {
		const request = makeRequest({
			...server.options,
			method
		});

		try {
			request.write('asdf');

			// eslint-disable-next-line no-await-in-loop
			const error = await pEvent(request, 'error');
			t.is(error.message, message);
		} catch (error) {
			// Node.js 12
			t.is(error.message, message);
		}

		request.destroy();
	}
});

test('the `response` event can be emitted after calling `request.write()`', wrapper, async (t, server) => {
	server.post('/', (request, response) => {
		request.resume();
		response.end();
	});

	const request = makeRequest({
		...server.options,
		method: 'POST'
	});
	request.write('anything');

	const response = await pEvent(request, 'response');
	t.is(response.statusCode, 200);

	await new Promise(resolve => {
		request.end(resolve);
	});
});

test('.connection is .socket', wrapper, async (t, server) => {
	const request = makeRequest(server.options);

	request.connection = 123;
	t.is(request.socket, 123);

	request.destroy();
});

test('throws when server aborts the request', wrapper, async (t, server) => {
	server.post('/', (_request, response) => {
		response.destroy();
	});

	const request = makeRequest(server.url);
	request.method = 'POST';
	request.flushHeaders();

	await t.throwsAsync(pEvent(request, 'neverGetsEmitted'), {
		message: 'The server aborted the HTTP/2 stream'
	});
});

test('`close` event is emitted', wrapper, async (t, server) => {
	const request = makeRequest(server.url);
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	await pEvent(request, 'close');

	t.pass();
});

test('throws on session.request() exception', proxyWrapper, async (t, server) => {
	const h2session = connect(server.url);

	const request = makeRequest({
		h2session,
		method: 'CONNECT',
		headers: {
			':path': '/'
		}
	});
	request.end();

	await t.throwsAsync(pEvent(request, 'neverGetsEmitted'), {
		message: ':authority header is required for CONNECT requests'
	});

	h2session.close();
});

test.cb('supports h2c when passing a custom session', t => {
	const server = createUnsecureServer((request, response) => {
		response.end('h2c');
	});

	server.listen(error => {
		if (error) {
			t.end(error);
			return;
		}

		const session = connect(`http://localhost:${server.address().port}`);

		const request = makeRequest({
			h2session: session
		}, async response => {
			const body = await getStream(response);

			t.is(body, 'h2c');

			session.close();
			server.close(t.end);
		});

		request.end();
	});
});

test('does not throw on connection: keep-alive header', wrapper, async (t, server) => {
	const request = makeRequest(server.url, {
		headers: {
			connection: 'keep-alive'
		}
	});
	request.end();

	const response = await pEvent(request, 'response');
	const body = await getStream(response);
	const {headers} = JSON.parse(body);

	t.false('connection' in headers);
});

test('does not throw on connection: keep-alive header (uppercase)', wrapper, async (t, server) => {
	const request = makeRequest(server.url, {
		headers: {
			connection: 'KEEP-ALIVE'
		}
	});
	request.end();

	const response = await pEvent(request, 'response');
	const body = await getStream(response);
	const {headers} = JSON.parse(body);

	t.false('connection' in headers);
});

test('throws on connection: close header', wrapper, async (t, server) => {
	t.throws(() => makeRequest(server.url, {
		headers: {
			connection: 'close'
		}
	}), {
		message: `Invalid 'connection' header: close`
	});
});

test('calculates valid server name', t => {
	t.is(calculateServerName('1.1.1.1'), '');
	t.is(calculateServerName('1.1.1.1:443'), '');
	t.is(calculateServerName('example.com'), 'example.com');
	t.is(calculateServerName('example.com:80'), 'example.com');
	t.is(calculateServerName('[2606:4700:4700::1111]'), '');
	t.is(calculateServerName('[2606:4700:4700::1111]:443'), '');
});

{
	const testFn = process.platform === 'win32' ? test.skip : test.serial;

	testFn('`socketPath` option', async t => {
		const socketPath = tempy.file({extension: 'socket'});

		const localServer = await createServer();
		await localServer.listen(socketPath);

		const request = makeRequest({
			socketPath,
			path: '/'
		});
		request.end();

		const response = await pEvent(request, 'response');
		const data = JSON.parse(await getStream(response));
		t.truthy(data);

		request.agent.destroy();

		await localServer.close();
	});
}
