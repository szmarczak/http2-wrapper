const {EventEmitter} = require('events');
const {promisify} = require('util');
const tls = require('tls');
const test = require('ava');
const getStream = require('get-stream');
const pEvent = require('p-event');
const is = require('@sindresorhus/is');
const {Agent, constants} = require('../source/index.js');
const {createWrapper, createServer} = require('./helpers/server.js');
const setImmediateAsync = require('./helpers/set-immediate-async.js');
const {key, cert} = require('./helpers/certs.js');

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

// ====================== TLS SESSIONS ======================

test('caches a TLS session when successfully connected', wrapper, async (t, server) => {
	const agent = new Agent();

	await agent.getSession(server.url);

	t.true(is.buffer(agent.tlsSessionCache.get(`${server.url}:${agent.normalizeOptions()}`)));

	agent.destroy();
});

test('reuses a TLS session', wrapper, async (t, server) => {
	const agent = new Agent();
	const session = await agent.getSession(server.url);

	const tlsSession = agent.tlsSessionCache.get(`${server.url}:${agent.normalizeOptions()}`);

	session.close();
	await pEvent(session, 'close');

	const secondSession = await agent.getSession(server.url);

	t.deepEqual(secondSession.socket.getSession(), tlsSession);
	t.true(is.buffer(tlsSession));

	agent.destroy();
});

test('purges the TLS session cache on session error', wrapper, async (t, server) => {
	const agent = new Agent();

	const session = await agent.getSession(server.url);

	t.true(is.buffer(agent.tlsSessionCache.get(`${server.url}:${agent.normalizeOptions()}`)));

	session.destroy(new Error(message));
	await pEvent(session, 'close', {rejectionEvents: []});

	t.true(is.undefined(agent.tlsSessionCache.get(`${server.url}:${agent.normalizeOptions()}`)));

	agent.destroy();
});

// ====================== CONSTRUCTOR ======================

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

test('`timeout` option', wrapper, async (t, server) => {
	const timeout = 500;
	const agent = new Agent({timeout});

	const started = Date.now();
	const session = await agent.getSession(server.url);

	t.is(agent.emptySessionCount, 1);

	await pEvent(session, 'close');
	const now = Date.now();
	const difference = now - started;

	t.is(agent.sessionCount, 0);
	t.true(difference >= timeout, `Timeout did not exceed ${timeout}ms (${difference}ms)`);

	agent.destroy();
});

test('`timeout` option - endless response', singleRequestWrapper, async (t, server) => {
	const timeout = 1000;
	const agent = new Agent({timeout});

	const secondStream = await agent.request(server.url, {}, {}, {endStream: false});

	await pEvent(secondStream, 'close');
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

test('`protocol` property', t => {
	const agent = new Agent();
	t.is(agent.protocol, 'https:');
});

test('`.sessions` may contain destroyed sessions', wrapper, async (t, server) => {
	const agent = new Agent();
	const session = await agent.getSession(server.url);
	session.destroy();

	t.is(Object.values(agent.sessions).length, 1);

	const that = Object.values(agent.sessions)[0][0];

	t.true(that.destroyed);

	agent.destroy();
});

test('`.sessions` may contain closed sessions', wrapper, async (t, server) => {
	const agent = new Agent();
	const session = await agent.getSession(server.url);
	session.close();

	t.is(Object.values(agent.sessions).length, 1);

	const that = Object.values(agent.sessions)[0][0];

	t.true(that.closed);
	t.false(that[Agent.kGracefullyClosing]);

	agent.destroy();
});

test('sessions are grouped into options and authorities`', wrapper, async (t, server) => {
	const agent = new Agent();

	const firstSession = await agent.getSession(server.url);
	const secondSession = await agent.getSession(server.url, {
		maxSessionMemory: 1
	});

	t.not(firstSession, secondSession);

	agent.destroy();
});

// ====================== SESSION OVERLOADING ======================

test('prevents session overloading #1', singleRequestWrapper, async (t, server) => {
	const agent = new Agent();

	const requestPromises = Promise.all([
		agent.request(server.url, {}, {}, {endStream: false}),
		agent.request(server.url, {}, {}, {endStream: false})
	]);

	const requests = await requestPromises;
	t.not(requests[0].session, requests[1].session);

	agent.destroy();
});

test('prevents session overloading #2', singleRequestWrapper, async (t, server) => {
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

test('prevents session overloading #3', tripleRequestWrapper, async (t, server) => {
	const agent = new Agent({
		maxSessions: 2
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

	t.is(agent.pendingSessionCount, 2);

	agent.destroy();
});

test('prevents session overloading #4', singleRequestWrapper, async (t, server) => {
	const agent = new Agent({
		maxSessions: 2
	});

	const serverSessionPromise = pEvent(server, 'session');

	const stream = await agent.request(server.url);
	const serverSession = await serverSessionPromise;

	serverSession.settings({
		maxConcurrentStreams: 2
	});

	const streams = await Promise.all([
		agent.request(server.url),
		agent.request(server.url)
	]);

	t.is(streams[0].session, stream.session);
	t.not(streams[0].session, streams[1].session);

	agent.destroy();
});

test('prevents session overloading #5', singleRequestWrapper, async (t, server) => {
	const secondServer = await createServer();
	await secondServer.listen();

	const agent = new Agent({
		maxSessions: 2
	});

	const serverSessionPromise = pEvent(server, 'session');

	const session = await agent.getSession(server.url);
	const serverSession = await serverSessionPromise;

	serverSession.origin(secondServer.url);

	await new Promise((resolve, reject) => {
		session.prependOnceListener('origin', async () => {
			try {
				const streams = await Promise.all([
					agent.request(secondServer.url),
					agent.request(secondServer.url)
				]);

				t.is(streams[0].session, session);
				t.not(streams[0].session, streams[1].session);
			} catch (error) {
				reject(error);
			} finally {
				resolve();
			}
		});
	});

	agent.destroy();

	await secondServer.close();
});

test('prevents session overloading #6', singleRequestWrapper, async (t, server) => {
	const agent = new Agent({
		maxSessions: 2
	});

	const serverSessionPromise = pEvent(server, 'session');

	const stream = await agent.request(server.url);
	const serverSession = await serverSessionPromise;

	serverSession.settings({
		maxConcurrentStreams: 3
	});

	const streams = await Promise.all([
		agent.request(server.url),
		agent.request(server.url)
	]);

	streams.push(await agent.request(server.url));

	t.is(streams[0].session, stream.session);
	t.is(streams[0].session, streams[1].session);
	t.not(stream.session, streams[2].session);

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
	t.is(agent.emptySessionCount, 0);
	t.is(agent.pendingSessionCount, 1);
	t.is(agent.sessionCount, 1);

	session.destroy();

	const request = await requestPromise;
	request.close();

	agent.destroy();
});

test('respects the `maxSessions` option #2', singleRequestWrapper, async (t, server) => {
	const secondServer = await createServer();

	await secondServer.listen();

	const agent = new Agent({
		maxSessions: 1
	});

	const ssp = pEvent(server, 'session');

	const a = await agent.request(server.url);

	const onSession = () => {
		t.fail('A new session was created');
	};

	agent.once('session', onSession);

	const bp = agent.request(server.url);
	const sp = agent.getSession(secondServer.url);

	const ss = await ssp;

	ss.settings({
		maxConcurrentStreams: 2
	});

	agent.off('session', onSession);

	const b = await bp;

	a.close();
	b.close();

	await sp;

	t.pass();

	agent.destroy();

	await secondServer.close();
});

test('creates new session if there are no free sessions', singleRequestWrapper, async (t, server) => {
	server.get('/infinite', () => {});

	const agent = new Agent();

	const first = await agent.request(server.url, server.options, {
		':path': '/infinite'
	});

	const second = await agent.request(server.url, server.options, {
		':path': '/infinite'
	});

	t.not(first.session, second.session);

	const closeEvents = [pEvent(first.session, 'close'), pEvent(second.session, 'close')];

	agent.destroy();

	await Promise.all(closeEvents);
});

// ====================== COVERED SESSIONS ======================

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

test('session can cover another session by increasing its streams count limit', singleRequestWrapper, async (t, server) => {
	const agent = new Agent();

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

test('does not close covered sessions if the current one is full', singleRequestWrapper, async (t, server) => {
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

// ====================== SESSION COUNT ======================

test('no negative session count', async t => {
	const agent = new Agent();
	await t.throwsAsync(agent.getSession('https://localhost'));

	t.is(agent.sessionCount, 0);
	t.is(agent.emptySessionCount, 0);
});

test('properly calculates session count #1', wrapper, async (t, server) => {
	const agent = new Agent();

	t.is(agent.sessionCount, 0);
	t.is(agent.emptySessionCount, 0);

	const session = await agent.getSession(server.url);

	t.is(agent.sessionCount, 1);
	t.is(agent.emptySessionCount, 1);

	agent.destroy();

	await pEvent(session, 'close');

	t.is(agent.sessionCount, 0);
	t.is(agent.emptySessionCount, 0);
});

test('properly calculates session count #2', wrapper, async (t, server) => {
	const agent = new Agent();

	t.is(agent.sessionCount, 0);
	t.is(agent.emptySessionCount, 0);

	const {session} = await agent.request(server.url);

	t.is(agent.sessionCount, 1);
	t.is(agent.emptySessionCount, 0);

	agent.destroy();

	await pEvent(session, 'close');

	t.is(agent.sessionCount, 0);
	t.is(agent.emptySessionCount, 0);
});

test('properly calculates session count #3', singleRequestWrapper, async (t, server) => {
	const agent = new Agent();

	t.is(agent.sessionCount, 0);
	t.is(agent.emptySessionCount, 0);

	const request = await agent.request(server.url);
	const {session} = request;

	t.is(agent.sessionCount, 1);
	t.is(agent.emptySessionCount, 0);

	request.close();

	await pEvent(request, 'close');

	t.is(agent.sessionCount, 1);
	t.is(agent.emptySessionCount, 1);

	session.close();

	await pEvent(session, 'close');

	t.is(agent.sessionCount, 0);
	t.is(agent.emptySessionCount, 0);
});

test('properly calculates session count #4', singleRequestWrapper, async (t, server) => {
	const agent = new Agent();

	t.is(agent.sessionCount, 0);
	t.is(agent.emptySessionCount, 0);

	const request = await agent.request(server.url);
	const {session} = request;

	t.is(agent.sessionCount, 1);
	t.is(agent.emptySessionCount, 0);

	session.destroy();

	await pEvent(request, 'close');

	t.is(agent.sessionCount, 1);
	t.is(agent.emptySessionCount, 1);

	await pEvent(session, 'close');

	t.is(agent.sessionCount, 0);
	t.is(agent.emptySessionCount, 0);
});

// ====================== SESSION PICKING ======================

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

	const request = await agent.request(server.url, {}, {}, {endStream: false});
	t.is(request.session, sessions[0].session);

	// Cleanup
	request.close();

	for (let i = 0; i < SESSIONS_COUNT; i++) {
		sessions[i].closeRequests();
	}

	agent.destroy();
});

test('sessions are picked in an optimal way #1', tripleRequestWrapper, async (t, server) => {
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

test('sessions are picked in an optimal way #2', tripleRequestWrapper, async (t, server) => {
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

test('picks sessions with the highest stream capacity (single origin)', tripleRequestWrapper, async (t, server) => {
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

test('picks sessions with the highest stream capacity (many origins)', async t => {
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

test('does not create a new session if there exists an authoritive one', wrapper, async (t, server) => {
	server.on('session', session => {
		session.origin('https://example.com');
	});

	const agent = new Agent();

	const session = await agent.getSession(server.url);
	await pEvent(session, 'origin');

	t.is(await agent.getSession('https://example.com'), session);

	agent.destroy();
});

test('session may become free on maxConcurrentStreams update', singleRequestWrapper, async (t, server) => {
	const agent = new Agent();
	const emitter = new EventEmitter();

	server.on('session', async session => {
		await pEvent(emitter, 'ack');

		session.settings({
			maxConcurrentStreams: 2
		});
	});

	const a = await agent.getSession(server.url);
	const request = a.request({}, {endStream: false});

	const b = await agent.getSession(server.url);
	emitter.emit('ack');

	await pEvent(a, 'remoteSettings');

	const c = await agent.getSession(server.url);

	t.is(a, c);
	t.not(a, b);

	request.close();
	agent.destroy();
});

test('gives free sessions if available', wrapper, async (t, server) => {
	const agent = new Agent();
	const first = await agent.getSession(server.url);

	t.is(agent.emptySessionCount, 1);

	const second = await agent.getSession(server.url);

	t.is(agent.emptySessionCount, 1);
	t.is(first, second);

	agent.destroy();
});

// ====================== ERRORS ======================

test('throws on servername mismatch', wrapper, async (t, server) => {
	const agent = new Agent();

	await t.throwsAsync(agent.getSession(server.url, {servername: 'foobar'}), {
		message: 'Origin localhost differs from servername foobar'
	});
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

test('errors on failure', async t => {
	const agent = new Agent();
	const error = await t.throwsAsync(agent.getSession(new URL('https://localhost')));

	t.is(error.port, 443);
	t.true(error.address === '127.0.0.1' || error.address === '::1');
});

test('catches session.request() errors', wrapper, async (t, server) => {
	const agent = new Agent();

	await t.throwsAsync(agent.request(server.url, {}, {}, false), {
		code: 'ERR_INVALID_ARG_TYPE',
		message: /^The "options" argument must be of type/
	});

	agent.destroy();
});

test('no infinity loop on endpoint mismatch', wrapper, async (t, server) => {
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

// ====================== EMPTY SESSIONS ======================

test('`.closeEmptySessions()` works', wrapper, async (t, server) => {
	{
		const agent = new Agent();
		const session = await agent.getSession(server.url);

		agent.closeEmptySessions();

		t.true(session.closed);
		t.false(session[Agent.kGracefullyClosing]);
		await pEvent(session, 'close');

		t.is(agent.emptySessionCount, 0);
		t.is(agent.pendingSessionCount, 0);

		agent.destroy();
	}

	{
		const agent = new Agent();
		const session = await agent.getSession(server.url);
		await agent.request(server.url);

		agent.closeEmptySessions();

		t.false(session.closed);
		t.false(session[Agent.kGracefullyClosing]);

		t.is(agent.emptySessionCount, 0);
		t.is(agent.pendingSessionCount, 1);

		agent.destroy();
	}
});

test('respects `.maxEmptySessions` changes', singleRequestWrapper, async (t, server) => {
	const agent = new Agent({
		maxEmptySessions: 2
	});

	let count = 0;
	agent.createConnection = (...args) => {
		count++;

		return Agent.connect(...args);
	};

	const stream = await agent.request(server.url, {}, {}, {endStream: false});
	const streamSession = stream.session;

	agent.maxEmptySessions = 1;
	stream.close();

	const session = await agent.getSession(server.url);
	t.is(session, streamSession);
	t.is(count, 2);

	const lateSession = await pEvent(server, 'session');
	await pEvent(lateSession, 'close');

	agent.destroy();
});

test('closes empty sessions automatically', wrapper, async (t, server) => {
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

test('`maxEmptySessions` set to 0 causes to close the session after running through the queue', wrapper, async (t, server) => {
	const agent = new Agent({
		maxEmptySessions: 0
	});

	const session = await agent.getSession(server.url);

	t.true(session.destroyed);

	agent.destroy();
});

// ====================== QUEUE ======================

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

test('processes session queue on session close', wrapper, async (t, server) => {
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

test('multiple entries in the queue', wrapper, async (t, server) => {
	const secondServer = await createServer();
	await secondServer.listen();

	const agent = new Agent();

	const sessions = await Promise.all([
		agent.getSession(server.url),
		agent.getSession(secondServer.url)
	]);

	t.not(sessions[0], sessions[1]);

	agent.destroy();

	await secondServer.close();
});

// ====================== AGENT DESTROY ======================

test('`agent.destroy()` destroys free sessions', wrapper, async (t, server) => {
	const agent = new Agent();
	const session = await agent.getSession(server.url);

	t.is(agent.emptySessionCount, 1);

	agent.destroy();
	await pEvent(session, 'close');

	t.is(agent.sessionCount, 0);
});

test('`agent.destroy()` destroys busy sessions', singleRequestWrapper, async (t, server) => {
	server.get('/infinite', () => {});

	const agent = new Agent();

	const request = await agent.request(server.url, server.options, {
		':path': '/infinite'
	});

	t.is(agent.pendingSessionCount, 1);

	agent.destroy(new Error(message));

	const error = await pEvent(request, 'error');
	t.is(error.message, message);

	t.is(agent.pendingSessionCount, 0);
});

test('`agent.destroy()` makes pending sessions throw', wrapper, async (t, server) => {
	const agent = new Agent();
	const sessionPromise = agent.getSession(server.url);

	agent.destroy();

	await t.throwsAsync(sessionPromise, {
		message: 'Agent has been destroyed'
	});
});

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! BUGS !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

test('does not throw if createConnection is explicitly undefined', wrapper, async (t, server) => {
	const agent = new Agent();

	await t.notThrowsAsync(agent.getSession(`https://localhost:${server.address().port}`, {
		createConnection: undefined
	}));

	agent.destroy();
});
