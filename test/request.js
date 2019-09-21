import EventEmitter from 'events';
import net from 'net';
import http2 from 'http2';
import test from 'ava';
import pEvent from 'p-event';
import getStream from 'get-stream';
import tempy from 'tempy';
import is from '@sindresorhus/is';
import {request as makeRequest, get, constants, connect, Agent, globalAgent} from '../source';
import isCompatible from '../source/utils/is-compatible';
import {createWrapper, createServer, createProxyServer} from './helpers/server';

if (isCompatible) {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

	const wrapper = createWrapper();
	const proxyWrapper = createWrapper({
		createServer: createProxyServer
	});

	const okHandler = (request, response) => {
		response.end('ok');
	};

	test('throws an error on invalid protocol', t => {
		t.throws(() => makeRequest('invalid://'), 'Protocol "invalid:" not supported. Expected "https:"');
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
		request.abort();

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
		t.true((/self signed certificate/).test(error.message) || error.message === 'unable to verify the first certificate');
	});

	test('`authority` option', async t => {
		const localServer = await createServer();
		await localServer.listen();

		const request = makeRequest({...localServer.options, authority: localServer.options});
		request.end();

		const response = await pEvent(request, 'response');
		const data = JSON.parse(await getStream(response));
		await localServer.close();

		t.is(data.headers[':authority'], `${localServer.options.hostname}:${localServer.options.port}`);
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

	test('`session` option', wrapper, async (t, server) => {
		let called = false;

		const session = connect(`${server.options.protocol}//${server.options.hostname}:${server.options.port}`);
		session._request = session.request;
		session.request = (...args) => {
			called = true;
			return session._request(...args);
		};

		const request = makeRequest({...server.options, session});
		request.end();

		await pEvent(request, 'finish');
		session.unref();
		t.true(called);
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
		request.end();
	});

	test('`headersSent` is `true` after flushing headers', wrapper, async (t, server) => {
		const request = makeRequest(server.options);
		request.end();

		await pEvent(request, 'finish');
		t.true(request.headersSent);
	});

	test('`timeout` option', wrapper, async (t, server) => {
		const request = makeRequest({
			...server.options,
			timeout: 1
		});
		request.end();

		await pEvent(request, 'timeout');
		request.abort();

		t.pass();
	});

	test('`.setTimeout()` works', wrapper, async (t, server) => {
		const request = makeRequest(server.options);
		request.setTimeout(1);
		request.end();

		await pEvent(request, 'timeout');
		request.abort();

		t.pass();
	});

	test('default port for `https:` protocol is 443', async t => {
		const request = makeRequest({protocol: 'https:', hostname: 'localhost'});
		request.end();

		const error = await pEvent(request, 'error');
		const address = error.address || error.cause.address;
		const port = error.port || error.cause.port;

		t.is(address, '127.0.0.1');
		t.is(port, 443);
	});

	test('throws on `http:` protocol', t => {
		t.throws(() => makeRequest({protocol: 'http:'}), 'Protocol "http:" not supported. Expected "https:"');
	});

	test('throws when acesssing `socket` after session destruction', wrapper, async (t, server) => {
		t.plan(1);

		const session = connect(`${server.options.protocol}//${server.options.hostname}:${server.options.port}`);
		const request = makeRequest(server.options, {session});
		request.end();

		const response = await pEvent(request, 'response');
		request.abort();
		session.close();

		response.socket.once('close', () => {
			t.throws(() => response.socket.destroyed);
		});
	});

	test('doesn\'t close custom sessions', wrapper, (t, server) => {
		const session = connect(`${server.options.protocol}//${server.options.hostname}:${server.options.port}`);
		const request = makeRequest({...server.options, session});
		request.abort();

		t.false(session.destroyed);
		session.close();
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
		request.end();

		const response = await pEvent(request, 'connect');
		const stream = response.req._request;
		t.true(response.upgrade);

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

		const err = await pEvent(request, 'error');
		t.is(err.message, error);
		t.true(request._request.destroyed);
		t.is(request.destroyed, true);
	});

	test('`.destroy(reason)` before ending the request', wrapper, async (t, server) => {
		const error = 'Simple error';

		const request = makeRequest(server.options);
		request.destroy(new Error(error));
		request.end();

		const err = await pEvent(request, 'error');
		t.is(err.message, error);
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
		request.abort();
		t.notThrows(() => request.end());
	});

	test('emits `abort` only once', wrapper, (t, server) => {
		let aborts = 0;

		const request = makeRequest(server.options);
		request.on('abort', () => aborts++);
		request.abort();
		request.abort();

		t.is(aborts, 0);
	});

	test('`.setNoDelay()` doesn\'t throw', wrapper, (t, server) => {
		const request = makeRequest(server.options);
		request.end();

		t.notThrows(() => request.setNoDelay());
	});

	test('`.setSocketKeepAlive()` doesn\'t throw', wrapper, (t, server) => {
		const request = makeRequest(server.options);
		request.end();

		t.notThrows(() => request.setSocketKeepAlive());
	});

	test('`.maxHeadersCount` - getter', wrapper, async (t, server) => {
		const request = makeRequest(server.options);
		t.is(request.maxHeadersCount, undefined);
		request.end();

		await pEvent(request, 'response');
		request.abort();
		t.true(is.number(request.maxHeadersCount));
	});

	test('`.maxHeadersCount` - empty setter', wrapper, async (t, server) => {
		const request = makeRequest(server.options);
		request.maxHeadersCount = 1;
		t.is(request.maxHeadersCount, undefined);
		request.end();

		await pEvent(request, 'response');
		request.abort();
		request.maxHeadersCount = undefined;
		t.true(is.number(request.maxHeadersCount));
	});

	test('throws if making a request on a closed session', wrapper, async (t, server) => {
		const session = http2.connect(server.url);
		session.destroy();

		const request = makeRequest({
			...server.options,
			session
		}).end();

		const error = await pEvent(request, 'error');
		t.is(error.code, 'ERR_HTTP2_INVALID_SESSION');
	});

	test('`.path` returns the pseudo path header', t => {
		const request = makeRequest({
			headers: {
				[constants.HTTP2_HEADER_PATH]: '/foobar'
			}
		});
		request.abort();

		t.is(request.path, '/foobar');
	});

	test('throws on invalid `agent` option', t => {
		t.throws(
			() => makeRequest({agent: 0}),
			'The "options.agent" property must be one of type Agent-like Object, undefined or false. Received number'
		);
	});

	test('uses `globalAgent` if `agent` is `null`', t => {
		const request = makeRequest({agent: null});
		t.is(request.agent, globalAgent);

		request.abort();
	});

	test('uses `globalAgent` if `agent` is `undefined`', t => {
		const request = makeRequest({agent: undefined});
		t.is(request.agent, globalAgent);

		request.abort();
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
		request.abort();

		t.true(called);
	});

	if (process.platform !== 'win32') {
		const socketPath = tempy.file({extension: 'socket'});

		test('`socketPath` option', async t => {
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

			await localServer.close();
		});
	}
}
