const {promisify} = require('util');
const tls = require('tls');
const test = require('ava');
const getStream = require('get-stream');
const pEvent = require('p-event');
const is = require('@sindresorhus/is');
const {Agent, constants} = require('../source');
const {createWrapper, createServer} = require('./helpers/server');
const setImmediateAsync = require('./helpers/set-immediate-async');
const {key, cert} = require('./helpers/certs.js');

const supportsTlsSessions = process.versions.node.split('.')[0] >= 11;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const wrapper = createWrapper();

const singleRequestWrapper = createWrapper({
	settings: {
		maxConcurrentStreams: 1
	}
});

const tripleRequestWrapper = createWrapper({
	settings: {
		maxConcurrentStreams: 3
	}
});

const message = 'Simple error';

test('getSession() - passing string as `origin`', wrapper, async (t, server) => {
	const agent = new Agent();
	await t.notThrowsAsync(agent.getSession(server.url));

	agent.destroy();
});

test('getSession() - passing URL as `origin`', wrapper, async (t, server) => {
	const agent = new Agent();

	await t.notThrowsAsync(agent.getSession(new URL(server.url)));

	await t.throwsAsync(agent.getSession({}), {
		message: 'The `origin` argument needs to be a string or an URL object'
	});

	agent.destroy();
});

test('sessions are not busy if still can make requests', wrapper, async (t, server) => {
	const agent = new Agent();
	const request = await agent.request(server.url);
	request.end().resume();

	t.is(Object.values(agent.freeSessions)[0].length, 1);
	t.is(Object.values(agent.busySessions).length, 0);

	await pEvent(request, 'close');

	t.is(Object.values(agent.freeSessions)[0].length, 1);
	t.is(Object.values(agent.busySessions).length, 0);

	agent.destroy();
});

test('sessions are busy when cannot make requests', singleRequestWrapper, async (t, server) => {
	const agent = new Agent();
	const request = await agent.request(server.url);
	request.end().resume();

	t.is(Object.values(agent.busySessions)[0].length, 1);
	t.is(Object.values(agent.freeSessions).length, 0);

	await pEvent(request, 'close');

	t.is(Object.values(agent.busySessions).length, 0);
	t.is(Object.values(agent.freeSessions)[0].length, 1);

	agent.destroy();
});

test('gives free sessions if available', wrapper, async (t, server) => {
	const agent = new Agent();
	const first = await agent.getSession(server.url);

	t.is(Object.values(agent.freeSessions)[0].length, 1);

	const second = await agent.getSession(server.url);

	t.is(Object.values(agent.freeSessions)[0].length, 1);
	t.is(first, second);

	agent.destroy();
});

test('gives the queued session if exists', wrapper, async (t, server) => {
	server.get('/infinite', () => {});

	const agent = new Agent({
		maxSessions: 1
	});

	const firstPromise = agent.getSession(server.url, {});

	t.is(Object.values(agent.queue).length, 1);
	t.is(Object.values(Object.values(agent.queue)[0]).length, 1);

	const queued = Object.values(Object.values(agent.queue)[0])[0];
	t.is(typeof queued, 'function');

	const secondPromise = agent.getSession(server.url, {});

	t.is(Object.values(agent.queue).length, 1);
	t.is(Object.values(Object.values(agent.queue)[0]).length, 1);

	t.is(Object.values(Object.values(agent.queue)[0])[0], queued);
	t.is(await firstPromise, await secondPromise);

	agent.destroy();
});

test.serial('`timeout` option', wrapper.lolex, async (t, server, clock) => {
	{
		// Patch global `setImmediate`
		const fn = global.setImmediate;
		global.setImmediate = (...args) => {
			fn(...args);

			global.setImmediate = fn;
			clock.runAll();
		};
	}

	const timeout = 500;
	const agent = new Agent({timeout});

	const started = Date.now();
	const session = await agent.getSession(server.url);

	t.is(Object.values(agent.freeSessions)[0].length, 1);

	clock.tick(timeout);

	await pEvent(session, 'close');
	const now = Date.now();
	const difference = now - started;

	t.is(Object.values(agent.freeSessions).length, 0);
	t.true(difference >= timeout, `Timeout did not exceed ${timeout}ms (${difference}ms)`);

	agent.destroy();
});

test.serial('`timeout` option - endless response', singleRequestWrapper.lolex, async (t, server, clock) => {
	const timeout = 1000;
	const agent = new Agent({timeout});

	const secondStream = await agent.request(server.url, {}, {}, {endStream: false});

	const promise = pEvent(secondStream, 'close');

	clock.tick(timeout);

	await promise;
	t.pass();

	agent.destroy();
});

test('respects the `maxSessions` option', singleRequestWrapper, async (t, server) => {
	server.get('/', (request, response) => {
		process.nextTick(() => {
			response.end();
		});
	});

	const agent = new Agent({
		maxSessions: 1
	});

	const {session} = (await agent.request(server.url, server.options, {}, {endStream: false})).end();
	const requestPromise = agent.request(server.url, server.options, {}, {endStream: false});

	t.is(typeof Object.values(Object.values(agent.queue)[0])[0], 'function');
	t.is(Object.values(agent.freeSessions).length, 0);
	t.is(Object.values(agent.busySessions).length, 1);
	t.is(Object.values(agent.busySessions)[0].length, 1);

	session.destroy();

	const request = await requestPromise;
	request.close();

	agent.destroy();
});

test('doesn\'t break on session `close` event', singleRequestWrapper, async (t, server) => {
	server.get('/', () => {});

	const agent = new Agent();
	const request = await agent.request(server.url);
	const {session} = request;

	const requestPromise = agent.request(server.url, {}, {}, {endStream: false});

	const emit = request.emit.bind(request);
	request.emit = (event, ...args) => {
		if (event === 'error') {
			t.pass();
		} else {
			emit(event, ...args);
		}
	};

	session.close();

	await requestPromise;
	if (process.versions.node.split('.')[0] < 12) {
		// Session `close` event is emitted before its streams send `close` event
		t.pass();
	} else {
		// Session `close` event is emitted after its streams send `close` event
		t.plan(1);
	}

	agent.destroy();
});

test('can destroy free sessions', wrapper, async (t, server) => {
	const agent = new Agent();
	const session = await agent.getSession(server.url);

	t.is(Object.values(agent.freeSessions)[0].length, 1);

	agent.destroy();
	await pEvent(session, 'close');

	t.is(Object.values(agent.freeSessions).length, 0);
});

test('creates new session if there are no free sessions', singleRequestWrapper, async (t, server) => {
	server.get('/infinite', () => {});

	const agent = new Agent();

	t.is(Object.values(agent.freeSessions).length, 0);
	t.is(Object.values(agent.busySessions).length, 0);

	const first = await agent.request(server.url, server.options, {
		':path': '/infinite'
	});

	t.is(Object.values(agent.freeSessions).length, 0);
	t.is(Object.values(agent.busySessions)[0].length, 1);

	const second = await agent.request(server.url, server.options, {
		':path': '/infinite'
	});

	const closeEvents = [pEvent(first.session, 'close'), pEvent(second.session, 'close')];

	t.is(Object.values(agent.freeSessions).length, 0);
	t.is(Object.values(agent.busySessions)[0].length, 2);

	agent.destroy();

	await Promise.all(closeEvents);

	t.is(Object.values(agent.freeSessions).length, 0);
	t.is(Object.values(agent.busySessions).length, 0);
});

test('can destroy busy sessions', singleRequestWrapper, async (t, server) => {
	server.get('/infinite', () => {});

	const agent = new Agent();

	const request = await agent.request(server.url, server.options, {
		':path': '/infinite'
	});

	t.is(Object.values(agent.busySessions)[0].length, 1);

	agent.destroy(new Error(message));

	const error = await pEvent(request, 'error');
	t.is(error.message, message);

	t.is(Object.values(agent.busySessions).length, 0);
});

test('`closeFreeSessions()` closes sessions with 0 pending streams only', wrapper, async (t, server) => {
	{
		const agent = new Agent();
		const session = await agent.getSession(server.url);

		agent.closeFreeSessions();

		t.true(session.closed);
		t.false(session[Agent.kGracefullyClosing]);
		await pEvent(session, 'close');

		t.is(Object.values(agent.freeSessions).length, 0);

		agent.destroy();
	}

	{
		const agent = new Agent();
		const session = await agent.getSession(server.url);
		await agent.request(server.url);

		agent.closeFreeSessions();

		t.false(session.closed);
		t.false(session[Agent.kGracefullyClosing]);
		t.is(Object.values(agent.freeSessions).length, 1);

		agent.destroy();
	}
});

test('throws if session is closed before receiving a SETTINGS frame', async t => {
	const server = tls.createServer({key, cert, ALPNProtocols: ['h2']}, socket => {
		socket.end();
	});

	server.listen = promisify(server.listen.bind(server));
	server.close = promisify(server.close.bind(server));

	await server.listen();

	const agent = new Agent();

	await t.throwsAsync(
		agent.request(`https://localhost:${server.address().port}`, {}, {}, {endStream: false}),
		{
			message: 'Session closed without receiving a SETTINGS frame'
		}
	);

	await server.close();
});

test('sessions are grouped into authorities and options`', wrapper, async (t, server) => {
	const agent = new Agent();

	const firstSession = await agent.getSession(server.url);
	const secondSession = await agent.getSession(server.url, {
		maxSessionMemory: 1
	});

	t.not(firstSession, secondSession);

	agent.destroy();
});

test('throws on servername mismatch', wrapper, async (t, server) => {
	const agent = new Agent();

	await t.throwsAsync(agent.getSession(server.url, {servername: 'foobar'}), {
		message: 'Origin localhost differs from servername foobar'
	});
});

test('appends to freeSessions after the stream has ended', singleRequestWrapper, async (t, server) => {
	server.get('/', () => {});

	const agent = new Agent({maxFreeSessions: 2});

	const firstRequest = await agent.request(server.url, {}, {}, {endStream: false});
	const secondRequest = await agent.request(server.url, {}, {}, {endStream: false});
	const thirdRequest = await agent.request(server.url, {}, {}, {endStream: false});

	firstRequest.close();
	secondRequest.close();

	await Promise.all([
		pEvent(firstRequest, 'close'),
		pEvent(secondRequest, 'close')
	]);

	thirdRequest.close();
	await pEvent(thirdRequest, 'close');

	await setImmediateAsync();

	t.is(Object.values(agent.freeSessions).length, 1);

	// The following is needed for Node.js >= 14,
	// as the session may be in the middle of the destroy process.
	const filtered = Object.values(agent.freeSessions)[0].filter(session => !session.destroyed);
	t.is(filtered.length, 2);

	agent.destroy();
});

test('prevents overloading sessions', singleRequestWrapper, async (t, server) => {
	const agent = new Agent();

	const requestPromises = Promise.all([
		agent.request(server.url, {}, {}, {endStream: false}),
		agent.request(server.url, {}, {}, {endStream: false})
	]);

	const requests = await requestPromises;
	t.not(requests[0].session, requests[1].session);

	agent.destroy();
});

test('prevents session overloading #3', singleRequestWrapper, async (t, server) => {
	t.timeout(1000);

	const agent = new Agent({
		maxSessions: 1
	});

	const serverSessionAPromise = pEvent(server, 'session');
	const sessionA = await agent.getSession(server.url);
	const serverSessionA = await serverSessionAPromise;

	sessionA.request({}, {endStream: false});

	const sessionBPromise = agent.getSession(server.url);

	serverSessionA.settings({
		maxConcurrentStreams: 2
	});

	const sessionB = await sessionBPromise;

	t.is(sessionA, sessionB);

	agent.destroy();
});

test('sessions can be manually overloaded', singleRequestWrapper, async (t, server) => {
	const agent = new Agent();

	const session = await agent.getSession(server.url);
	const requests = [
		session.request({}, {endStream: false}),
		session.request({}, {endStream: false})
	];

	t.is(requests[0].session, requests[1].session);

	agent.destroy();
});

test('sessions can be manually overloaded #2', singleRequestWrapper, async (t, server) => {
	server.get('/', (request, response) => {
		response.end();
	});

	const agent = new Agent();

	const session = await agent.getSession(server.url);
	const requests = [
		session.request({}, {endStream: false}),
		session.request({}, {endStream: false})
	];

	requests[0].end();

	await pEvent(requests[0], 'close');

	t.pass();

	agent.destroy();
});

test('`.settings` property', wrapper, async (t, server) => {
	const agent = new Agent();
	agent.settings.maxHeaderListSize = 100;

	const session = await agent.getSession(server.url);
	await pEvent(session, 'localSettings');

	t.is(session.localSettings.maxHeaderListSize, 100);

	agent.destroy();
});

{
	const testFn = supportsTlsSessions ? test : test.skip;

	testFn('caches a TLS session when successfully connected', wrapper, async (t, server) => {
		const agent = new Agent();

		await agent.getSession(server.url);
		await setImmediateAsync();

		t.true(is.buffer(agent.tlsSessionCache.get(`${server.url}:${agent.normalizeOptions()}`)));

		agent.destroy();
	});

	testFn('reuses a TLS session', wrapper, async (t, server) => {
		const agent = new Agent();
		const session = await agent.getSession(server.url);
		await setImmediateAsync();

		const tlsSession = agent.tlsSessionCache.get(`${server.url}:${agent.normalizeOptions()}`);

		session.close();
		await pEvent(session, 'close');

		const secondSession = await agent.getSession(server.url);

		t.deepEqual(secondSession.socket.getSession(), tlsSession);
		t.true(is.buffer(tlsSession));

		agent.destroy();
	});

	testFn('purges the TLS session cache on session error', wrapper, async (t, server) => {
		const agent = new Agent();

		const session = await agent.getSession(server.url);
		await setImmediateAsync();

		t.true(is.buffer(agent.tlsSessionCache.get(`${server.url}:${agent.normalizeOptions()}`)));

		session.destroy(new Error(message));
		await pEvent(session, 'close', {rejectionEvents: []});

		t.true(is.undefined(agent.tlsSessionCache.get(`${server.url}:${agent.normalizeOptions()}`)));

		agent.destroy();
	});
}

// eslint-disable-next-line ava/no-skip-test
test.skip('throws on invalid usage', wrapper, async (t, server) => {
	const agent = new Agent();
	const session = await agent.getSession(server.url);

	t.throws(() => session.request(), 'Invalid usage. Use `await agent.request(authority, options, headers)` instead.');

	agent.destroy();
});

test('doesn\'t create a new session if there exists an authoritive one', wrapper, async (t, server) => {
	server.on('session', session => {
		session.origin('https://example.com');
	});

	const agent = new Agent();

	const session = await agent.getSession(server.url);
	await pEvent(session, 'origin');

	t.is(await agent.getSession('https://example.com'), session);

	agent.destroy();
});

test('closes covered sessions - `origin` event', wrapper, async (t, server) => {
	const secondServer = await createServer();
	const agent = new Agent();

	secondServer.on('session', session => {
		session.origin(server.url);
	});
	await secondServer.listen();

	const firstSession = await agent.getSession(server.url);
	const secondSession = await agent.getSession(secondServer.url);
	await pEvent(secondSession, 'origin');

	t.true(firstSession.closed);
	t.false(secondSession[Agent.kGracefullyClosing]);
	t.false(secondSession.closed);
	t.false(secondSession[Agent.kGracefullyClosing]);

	t.true(firstSession.destroyed);
	t.false(secondSession.destroyed);

	agent.destroy();

	await secondServer.close();
});

test('closes covered sessions - session no longer busy', singleRequestWrapper, async (t, server) => {
	const secondServer = await createServer();
	const agent = new Agent();

	secondServer.on('session', session => {
		session.origin(server.url);
	});
	await secondServer.listen();

	const firstSession = await agent.getSession(server.url);
	const request = await agent.request(server.url, {}, {}, {endStream: false});

	const secondSession = await agent.getSession(secondServer.url);
	await pEvent(secondSession, 'origin');

	t.false(firstSession.closed);
	t.true(firstSession[Agent.kGracefullyClosing]);
	t.false(secondSession.closed);
	t.false(secondSession[Agent.kGracefullyClosing]);

	t.false(firstSession.destroyed);
	t.false(firstSession.destroyed);

	request.close();

	await setImmediateAsync();

	t.true(firstSession.destroyed);
	t.false(secondSession.destroyed);

	agent.destroy();

	await secondServer.close();
});

test('doesn\'t close covered sessions if the current one is full', singleRequestWrapper, async (t, server) => {
	const secondServer = await createServer();
	const agent = new Agent();

	await secondServer.listen();
	server.on('session', session => {
		session.origin(secondServer.url);
	});

	const request = await agent.request(server.url, {}, {}, {endStream: false});
	const secondRequest = await agent.request(secondServer.url, {}, {}, {endStream: false});
	const {session} = request;
	const secondSession = secondRequest.session;

	t.not(session, secondSession);
	t.false(session.closed);
	t.false(session[Agent.kGracefullyClosing]);
	t.false(session.destroyed);
	t.false(secondSession.closed);
	t.false(secondSession[Agent.kGracefullyClosing]);
	t.false(secondSession.destroyed);

	request.close();

	await setImmediateAsync();

	t.false(session.closed);
	t.false(session[Agent.kGracefullyClosing]);
	t.false(session.destroyed);
	t.false(secondSession.closed);
	t.true(secondSession[Agent.kGracefullyClosing]);
	t.false(secondSession.destroyed);

	secondRequest.close();

	agent.destroy();

	await secondServer.close();
});

test('uses sessions which are more loaded to use fewer connections', tripleRequestWrapper, async (t, server) => {
	const SESSIONS_COUNT = 3;

	const agent = new Agent({maxFreeSessions: SESSIONS_COUNT});
	const generateRequests = (session, count) => {
		const requests = [];

		for (let i = 0; i < count; i++) {
			requests.push(session.request({}, {endStream: false}));
		}

		return requests;
	};

	// Prepare busy sessions
	const sessions = [];
	for (let i = 0; i < SESSIONS_COUNT; i++) {
		// eslint-disable-next-line no-await-in-loop
		const session = await agent.getSession(server.url);

		sessions.push({
			session,
			requests: generateRequests(session, session.remoteSettings.maxConcurrentStreams),
			closeRequests(count) {
				if (!count) {
					count = this.requests.length;
				}

				for (let i = 0; i < count; i++) {
					this.requests.shift().close();
				}
			}
		});
	}

	// First session: pending 2 requests / 3
	sessions[0].closeRequests(1);

	// Second session: pending 1 request / 3
	sessions[1].closeRequests(2);

	// Third session: pending 0 requests / 3
	sessions[2].closeRequests(3);

	await setImmediateAsync();

	// Node.js 10 fails without this
	await setImmediateAsync();

	const request = await agent.request(server.url, {}, {}, {endStream: false});
	t.is(request.session, sessions[0].session);

	// Cleanup
	request.close();

	for (let i = 0; i < SESSIONS_COUNT; i++) {
		sessions[i].closeRequests();
	}

	agent.destroy();
});

test('`.freeSessions` may contain destroyed sessions', wrapper, async (t, server) => {
	const agent = new Agent();
	const session = await agent.getSession(server.url);
	session.destroy();

	t.is(Object.values(agent.freeSessions).length, 1);
	t.is(Object.values(Object.values(agent.freeSessions)[0]).length, 1);

	t.true(Object.values(Object.values(agent.freeSessions)[0])[0].destroyed);

	agent.destroy();
});

test('`.freeSessions` may contain closed sessions', wrapper, async (t, server) => {
	const agent = new Agent();
	const session = await agent.getSession(server.url);
	session.close();

	t.is(Object.values(agent.freeSessions).length, 1);
	t.is(Object.values(Object.values(agent.freeSessions)[0]).length, 1);

	const that = Object.values(Object.values(agent.freeSessions)[0])[0];

	t.true(that.closed);
	t.false(that[Agent.kGracefullyClosing]);

	agent.destroy();
});

test('`maxFreeSessions` set to 0 causes to close the session after running through the queue', wrapper, async (t, server) => {
	const agent = new Agent();
	const sessionPromise = agent.getSession(server.url);

	agent.maxFreeSessions = 0;

	const session = await sessionPromise;
	await setImmediateAsync();

	t.true(session.destroyed);

	agent.destroy();
});

{
	// See https://github.com/nodejs/node/issues/36883
	const [major, minor] = process.versions.node.split('.').map(x => Number(x));
	const testFn = major === 12 && minor >= 20 ? test.serial.skip : test.serial;

	testFn('respects `.maxFreeSessions` changes', singleRequestWrapper, async (t, server) => {
		const agent = new Agent({
			maxFreeSessions: 2
		});

		let count = 0;
		agent.createConnection = (...args) => {
			count++;

			return Agent.connect(...args);
		};

		const stream = await agent.request(server.url, {}, {}, {endStream: false});
		const streamSession = stream.session;

		agent.maxFreeSessions = 1;
		stream.close();

		const session = await agent.getSession(server.url);
		t.is(session, streamSession);
		t.is(count, 2);

		const lateSession = await pEvent(server, 'session');
		await pEvent(lateSession, 'close');

		agent.destroy();
	});
}

test('destroying causes pending sessions to throw', wrapper, async (t, server) => {
	const agent = new Agent();
	const sessionPromise = agent.getSession(server.url);

	agent.destroy();

	await t.throwsAsync(sessionPromise, {
		message: 'Agent has been destroyed'
	});
});

test('newly queued sessions should not throw after `agent.destroy()`', wrapper, async (t, server) => {
	const agent = new Agent();
	const sessionPromise = agent.getSession(server.url);
	agent.destroy();

	await t.throwsAsync(sessionPromise, {
		message: 'Agent has been destroyed'
	});
	await t.notThrowsAsync(agent.getSession(server.url));

	agent.destroy();
});

test('free sessions can become suddenly covered by shrinking their current streams count', tripleRequestWrapper, async (t, server) => {
	const agent = new Agent({
		maxFreeSessions: 1
	});

	const sessions = {};

	{
		const serverSessionPromise = pEvent(server, 'session');
		const session = await agent.getSession(server.url);
		const serverSession = await serverSessionPromise;

		serverSession.origin('https://example.com');
		await pEvent(session, 'origin');

		sessions.a = {
			client: session,
			server: serverSession,
			requests: [
				session.request({}, {endStream: false}),
				session.request({}, {endStream: false}),
				session.request({}, {endStream: false})
			]
		};
	}

	{
		const session = await agent.getSession(server.url);

		sessions.b = {
			client: session,
			server: undefined,
			requests: [
				session.request({}, {endStream: false}),
				session.request({}, {endStream: false})
			]
		};
	}

	sessions.a.requests.shift().close();

	const requestB = sessions.b.requests.shift();
	const promise = pEvent(requestB, 'close');
	requestB.close();

	await promise;

	t.not(sessions.a.client, sessions.b.client);
	t.true(sessions.b.client[Agent.kGracefullyClosing]);
	t.false(sessions.b.client.closed);
	t.true(sessions.b.client[Agent.kGracefullyClosing]);

	agent.destroy();
});

test('busy sessions can become suddenly covered by shrinking their current streams count', tripleRequestWrapper, async (t, server) => {
	const agent = new Agent({
		maxFreeSessions: 1
	});

	const sessions = {};

	{
		const serverSessionPromise = pEvent(server, 'session');
		const session = await agent.getSession(server.url);
		const serverSession = await serverSessionPromise;

		serverSession.origin('https://example.com');
		await pEvent(session, 'origin');

		sessions.a = {
			client: session,
			server: serverSession,
			requests: [
				session.request({}, {endStream: false}),
				session.request({}, {endStream: false}),
				session.request({}, {endStream: false})
			]
		};
	}

	{
		const serverSessionPromise = pEvent(server, 'session');
		const session = await agent.getSession(server.url);
		const serverSession = await serverSessionPromise;

		sessions.b = {
			client: session,
			server: serverSession,
			requests: [
				session.request({}, {endStream: false}),
				session.request({}, {endStream: false})
			]
		};

		serverSession.settings({
			maxConcurrentStreams: 1
		});

		const secondRequest = sessions.b.requests[1];

		await pEvent(session, 'remoteSettings');

		const error = await pEvent(secondRequest, 'error');
		t.is(error.code, 'ERR_HTTP2_STREAM_ERROR');
		t.is(error.message, 'Stream closed with error code NGHTTP2_REFUSED_STREAM');
	}

	const requestA = sessions.a.requests.shift();
	const promiseA = pEvent(requestA, 'close');
	requestA.close();

	await promiseA;

	const requestB = sessions.b.requests.shift();
	const promiseB = pEvent(requestB, 'close');
	requestB.close();

	await promiseB;

	t.not(sessions.a.client, sessions.b.client);
	t.true(sessions.b.client.closed);
	t.true(sessions.b.client[Agent.kGracefullyClosing]);

	agent.destroy();
});

test('prevents overloading sessions #4', tripleRequestWrapper, async (t, server) => {
	const agent = new Agent({
		maxFreeSessions: 1
	});

	const sessions = {};

	{
		const session = await agent.getSession(server.url);

		sessions.a = session;
		sessions.a.requests = [
			session.request({}, {endStream: false}),
			session.request({}, {endStream: false}),
			session.request({}, {endStream: false})
		];
	}

	{
		const serverSessionPromise = pEvent(server, 'session');
		const session = await agent.getSession(server.url);
		const serverSession = await serverSessionPromise;

		sessions.b = session;
		sessions.b.requests = [
			session.request({}, {endStream: false}),
			session.request({}, {endStream: false}),
			session.request({}, {endStream: false})
		];

		sessions.a.requests.shift().close();

		serverSession.settings({
			maxConcurrentStreams: 4
		});

		await pEvent(session, 'remoteSettings');
	}

	t.is(Object.values(agent.freeSessions).length, 1);
	t.is(Object.values(agent.freeSessions)[0].length, 2);

	agent.destroy();
});

test('a session can cover other session by increasing its streams count limit', singleRequestWrapper, async (t, server) => {
	const agent = new Agent({
		maxFreeSessions: 2
	});

	const serverSessionAPromise = pEvent(server, 'session');
	const sessionA = await agent.getSession(server.url);
	const serverSessionA = await serverSessionAPromise;

	serverSessionA.origin('https://example.com');
	await pEvent(sessionA, 'origin');

	sessionA.request({}, {endStream: false});

	const sessionB = await agent.getSession(server.url);

	serverSessionA.settings({
		maxConcurrentStreams: 2
	});

	await pEvent(sessionA, 'remoteSettings');

	t.true(sessionB.closed);
	t.true(sessionB[Agent.kGracefullyClosing]);

	agent.destroy();
});

test('`session` event', wrapper, async (t, server) => {
	const agent = new Agent();

	let called = false;
	agent.once('session', session => {
		called = true;

		t.false(session.closed);
		t.false(session[Agent.kGracefullyClosing]);
	});

	await agent.getSession(server.url);
	t.true(called);

	agent.destroy();
});

test('errors on failure', async t => {
	const agent = new Agent();
	const error = await t.throwsAsync(agent.getSession(new URL('https://localhost')));

	t.is(error.port, 443);
	t.is(error.address, '127.0.0.1');
});

test('no negative session count', async t => {
	const agent = new Agent();
	await t.throwsAsync(agent.getSession('https://localhost'));

	t.is(agent._sessionsCount, 0);
	t.is(agent._freeSessionsCount, 0);
});

test('properly calculates session count #1', wrapper, async (t, server) => {
	const agent = new Agent();

	t.is(agent._sessionsCount, 0);
	t.is(agent._freeSessionsCount, 0);

	const session = await agent.getSession(server.url);

	t.is(agent._sessionsCount, 1);
	t.is(agent._freeSessionsCount, 1);

	agent.destroy();

	await pEvent(session, 'close');

	t.is(agent._sessionsCount, 0);
	t.is(agent._freeSessionsCount, 0);
});

test('properly calculates session count #2', wrapper, async (t, server) => {
	const agent = new Agent();

	t.is(agent._sessionsCount, 0);
	t.is(agent._freeSessionsCount, 0);

	const {session} = await agent.request(server.url);

	t.is(agent._sessionsCount, 1);
	t.is(agent._freeSessionsCount, 1);

	agent.destroy();

	await pEvent(session, 'close');

	t.is(agent._sessionsCount, 0);
	t.is(agent._freeSessionsCount, 0);
});

test('properly calculates session count #3', singleRequestWrapper, async (t, server) => {
	const agent = new Agent();

	t.is(agent._sessionsCount, 0);
	t.is(agent._freeSessionsCount, 0);

	const request = await agent.request(server.url);
	const {session} = request;

	t.is(agent._sessionsCount, 1);
	t.is(agent._freeSessionsCount, 0);

	request.close();

	await pEvent(request, 'close');

	t.is(agent._sessionsCount, 1);
	t.is(agent._freeSessionsCount, 1);

	session.close();

	await pEvent(session, 'close');

	t.is(agent._sessionsCount, 0);
	t.is(agent._freeSessionsCount, 0);
});

test('properly calculates session count #4', singleRequestWrapper, async (t, server) => {
	const agent = new Agent();

	t.is(agent._sessionsCount, 0);
	t.is(agent._freeSessionsCount, 0);

	const request = await agent.request(server.url);
	const {session} = request;

	t.is(agent._sessionsCount, 1);
	t.is(agent._freeSessionsCount, 0);

	session.destroy();

	await pEvent(request, 'close');

	t.is(agent._sessionsCount, 1);
	t.is(agent._freeSessionsCount, 0);

	await pEvent(session, 'close');

	t.is(agent._sessionsCount, 0);
	t.is(agent._freeSessionsCount, 0);
});

test('catches session.request() errors', wrapper, async (t, server) => {
	const agent = new Agent();

	await t.throwsAsync(agent.request(server.url, {}, {}, false), {
		code: 'ERR_INVALID_ARG_TYPE',
		message: /^The "options" argument must be of type/
	});

	agent.destroy();
});

test('makes requests on a session with biggest stream capacity', async t => {
	const server = await createServer({
		settings: {
			maxConcurrentStreams: 10
		},
		origins: [
			'https://b.com'
		]
	});

	await server.listen();

	const secondServer = await createServer({
		settings: {
			maxConcurrentStreams: 100
		},
		origins: [
			server.url,
			// This is needed so this Origin Set is not a subset of the above
			'https://a.com'
		]
	});

	await secondServer.listen();

	const agent = new Agent();

	const firstSession = await agent.getSession(server.url);

	const secondSession = await agent.getSession(secondServer.url);
	await pEvent(secondSession, 'origin');

	const thirdSession = await agent.getSession(server.url);

	t.not(firstSession, secondSession);
	t.is(thirdSession, secondSession);

	agent.destroy();

	await Promise.all([server, secondServer].map(server => server.close()));
});

test('graceful close works', wrapper, async (t, server) => {
	server.on('session', session => {
		session.once('goaway', () => {
			session.destroy('', constants.NGHTTP2_ENHANCE_YOUR_CALM);
		});
	});

	const secondServer = await createServer({
		origins: [
			server.url
		]
	});

	await secondServer.listen();

	const agent = new Agent();

	const firstSession = await agent.getSession(server.url);
	const firstRequest = firstSession.request({}, {endStream: false});

	const secondSession = await agent.getSession(secondServer.url);
	await pEvent(secondSession, 'origin');

	t.throws(() => firstSession.request(), {
		message: 'The session is gracefully closing. No new streams are allowed.'
	});

	t.false(firstRequest.destroyed);
	t.false(firstRequest.closed);

	t.false(firstSession.closed);
	t.true(firstSession[Agent.kGracefullyClosing]);

	t.not(firstSession, secondSession);

	const newRequest = await agent.request(server.url);
	t.is(newRequest.session, secondSession);

	newRequest.close();
	firstRequest.close();

	await pEvent(firstRequest, 'close');

	t.true(firstSession.closed);
	t.true(firstSession[Agent.kGracefullyClosing]);

	agent.destroy();

	await secondServer.close();
});

test('`protocol` property', t => {
	const agent = new Agent();
	t.is(agent.protocol, 'https:');
});

test('session are being picked in an optimal way #1', tripleRequestWrapper, async (t, server) => {
	server.get('/', () => {});

	const agent = new Agent();
	const requests = await Promise.all([
		agent.request(server.url),
		agent.request(server.url),
		agent.request(server.url),
		agent.request(server.url),
		agent.request(server.url),
		agent.request(server.url)
	]);

	t.is(requests[0].session, requests[1].session);
	t.is(requests[0].session, requests[2].session);
	t.is(requests[3].session, requests[4].session);
	t.is(requests[3].session, requests[5].session);

	{
		const toDestroy = [0, 1, 5];

		const wait = Promise.all(toDestroy.map(index => pEvent(requests[index], 'close')));

		for (const index of toDestroy) {
			requests[index].destroy();
		}

		await wait;
	}

	const newer = await agent.request(server.url);

	t.is(newer.session, requests[4].session);

	agent.destroy();
});

test('session are being picked in an optimal way #2', tripleRequestWrapper, async (t, server) => {
	server.get('/', () => {});

	const agent = new Agent();
	const requests = await Promise.all([
		agent.request(server.url),
		agent.request(server.url),
		agent.request(server.url),
		agent.request(server.url),
		agent.request(server.url),
		agent.request(server.url)
	]);

	t.is(requests[0].session, requests[1].session);
	t.is(requests[0].session, requests[2].session);
	t.is(requests[3].session, requests[4].session);
	t.is(requests[3].session, requests[5].session);

	{
		const toDestroy = [0, 4, 5];

		const wait = Promise.all(toDestroy.map(index => pEvent(requests[index], 'close')));

		for (const index of toDestroy) {
			requests[index].destroy();
		}

		await wait;
	}

	const newer = await agent.request(server.url);

	t.is(newer.session, requests[2].session);

	agent.destroy();
});

test('sessions are sorted highest to lowest capacity', tripleRequestWrapper, async (t, server) => {
	const secondServer = await createServer({
		settings: {
			maxConcurrentStreams: 1
		}
	});

	const thirdServer = await createServer({
		settings: {
			maxConcurrentStreams: 4
		}
	});

	await secondServer.listen();
	await thirdServer.listen();

	const agent = new Agent();

	const sessions = [
		await agent.getSession(server.url),
		await agent.getSession(secondServer.url),
		await agent.getSession(thirdServer.url)
	];

	t.is(Object.values(agent.sessions).length, 1);
	t.deepEqual(Object.values(agent.sessions)[0], [
		sessions[2],
		sessions[0],
		sessions[1]
	]);

	agent.destroy();

	await thirdServer.close();
	await secondServer.close();
});

// eslint-disable-next-line ava/no-skip-test
test.skip('supports custom hosts', async t => {
	const server = await createServer({
		origins: ['https://example.com']
	});

	server.get('/', (request, response) => {
		response.end('ok');
	});

	await server.listen();

	const agent = new Agent();

	await agent.getSession('https://example.com', {host: 'localhost', port: server.options.port});

	const stream = await agent.request('https://example.com');
	const body = await getStream(stream);

	t.is(body, 'ok');

	agent.destroy();

	await server.close();
});

test('no infinity loop', wrapper, async (t, server) => {
	server.get('/', (request, response) => {
		response.end('ok');
	});

	const agent = new Agent();

	await t.throwsAsync((async () => {
		await agent.getSession('https://example.com', {host: 'localhost', port: server.options.port});

		const stream = await agent.request('https://example.com');
		const body = await getStream(stream);

		t.is(body, 'ok');

		agent.destroy();
	})(), {
		message: `Requested origin https://example.com does not match server https://example.com:${server.options.port}`
	});
});

test('closes free sessions automatically', wrapper, async (t, server) => {
	const secondServer = await createServer();
	await secondServer.listen();

	const agent = new Agent({maxSessions: 1});

	const session = await agent.getSession(server.url);
	const secondSession = await agent.getSession(secondServer.url);

	t.true(session.closed);
	t.false(secondSession.closed);

	agent.destroy();

	await secondServer.close();
});

test('can process different sessions on session close', wrapper, async (t, server) => {
	const secondServer = await createServer();
	await secondServer.listen();

	const agent = new Agent({maxSessions: 1});

	const request = await agent.request(server.url);
	const secondSessionPromise = agent.getSession(secondServer.url, {rejectUnauthorized: false});

	request.close();

	const secondSession = await secondSessionPromise;
	secondSession.close();

	t.pass();

	await secondServer.close();
});
