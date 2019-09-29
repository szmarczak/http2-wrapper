import {promisify} from 'util';
import tls from 'tls';
import test from 'ava';
import createCert from 'create-cert';
import pEvent from 'p-event';
import is from '@sindresorhus/is';
import {Agent} from '../source';
import isCompatible from '../source/utils/is-compatible';
import {createWrapper, createServer} from './helpers/server';
import setImmediateAsync from './helpers/set-immediate-async';

const supportsTlsSessions = process.versions.node.split('.')[0] >= 11;

if (isCompatible) {
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

	test('passing string as `authority`', wrapper, async (t, server) => {
		const agent = new Agent();
		await t.notThrowsAsync(agent.getSession(server.url));

		agent.destroy();
	});

	test('passing options as `authority`', wrapper, async (t, server) => {
		const agent = new Agent();

		await t.notThrowsAsync(agent.getSession({
			hostname: server.options.hostname,
			port: server.options.port
		}));

		await t.notThrowsAsync(agent.getSession({
			host: server.options.hostname,
			port: server.options.port
		}));

		await t.notThrowsAsync(agent.getSession({
			host: server.options.hostname,
			servername: server.options.hostname,
			port: server.options.port
		}));

		await t.notThrowsAsync(agent.getSession({
			port: server.options.port
		}));

		const error = await t.throwsAsync(agent.getSession({}));
		t.is(error.port, 443);
		t.is(error.address, '127.0.0.1');

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

		t.is(typeof Object.values(agent.queue[''])[0], 'function');

		const secondPromise = agent.getSession(server.url, {});

		t.is(typeof Object.values(agent.queue[''])[0], 'function');
		t.is(await firstPromise, await secondPromise);

		agent.destroy();
	});

	test.serial('`timeout` option', wrapper.lolex, async (t, server, clock) => {
		const timeout = 500;
		const agent = new Agent({timeout});

		const started = Date.now();
		const session = await agent.getSession(server.url);

		t.is(Object.values(agent.freeSessions)[0].length, 1);

		agent.once('close', () => clock.tick(0));
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

		const secondStream = await agent.request(server.url);

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

		const {session} = (await agent.request(server.url, server.options)).end();
		const requestPromise = agent.request(server.url, server.options);

		t.is(typeof Object.values(agent.queue[''])[0], 'function');
		t.is(Object.values(agent.freeSessions).length, 0);
		t.is(Object.values(agent.busySessions['']).length, 1);

		session.destroy();

		const request = await requestPromise;
		request.close();

		agent.destroy();
	});

	test('doesn\'t break on session `close` event', singleRequestWrapper, async (t, server) => {
		server.get('/', () => {});

		const agent = new Agent();
		const request = (await agent.request(server.url)).end();
		const {session} = request;

		const requestPromise = agent.request(server.url);

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

		const first = (await agent.request(server.url, server.options, {
			':path': '/infinite'
		})).end();

		t.is(Object.values(agent.freeSessions).length, 0);
		t.is(Object.values(agent.busySessions)[0].length, 1);

		const second = (await agent.request(server.url, server.options, {
			':path': '/infinite'
		})).end();

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
		agent.once('error', () => {});

		const request = await agent.request(server.url, server.options, {
			':path': '/infinite'
		});
		request.end();

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

			t.is(session.closed, true);
			await pEvent(session, 'close');

			t.is(Object.values(agent.freeSessions).length, 0);

			agent.destroy();
		}

		{
			const agent = new Agent();
			const session = await agent.getSession(server.url);
			(await agent.request(server.url)).end();

			agent.closeFreeSessions();

			t.is(session.closed, false);
			t.is(Object.values(agent.freeSessions).length, 1);

			agent.destroy();
		}
	});

	test('throws if session is closed before receiving a SETTINGS frame', async t => {
		const {key, cert} = await createCert();

		const server = tls.createServer({key, cert, ALPNProtocols: ['h2']}, socket => {
			setImmediate(() => {
				socket.destroy();
			});
		});

		server.listen = promisify(server.listen.bind(server));
		server.close = promisify(server.close.bind(server));

		await server.listen();

		const agent = new Agent();

		await t.throwsAsync(
			agent.request(`https://localhost:${server.address().port}`),
			'Session closed without receiving a SETTINGS frame'
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

	test('custom servername', wrapper, async (t, server) => {
		const agent = new Agent();

		const session = await agent.getSession(server.url, {servername: 'foobar'});
		t.is(session.socket.servername, 'foobar');

		agent.destroy();
	});

	test('appends to freeSessions after the stream has ended', singleRequestWrapper, async (t, server) => {
		server.get('/', () => {});

		const agent = new Agent({maxFreeSessions: 2});

		const firstRequest = await agent.request(server.url);
		const secondRequest = await agent.request(server.url);
		const thirdRequest = await agent.request(server.url);

		firstRequest.close();
		secondRequest.close();

		await Promise.all([
			pEvent(firstRequest, 'close'),
			pEvent(secondRequest, 'close')
		]);

		thirdRequest.close();
		await pEvent(thirdRequest, 'close');

		await setImmediateAsync();
		t.is(agent.freeSessions[''].length, 2);

		agent.destroy();
	});

	test('prevents overloading sessions', singleRequestWrapper, async (t, server) => {
		const agent = new Agent();

		const requestPromises = Promise.all([agent.request(server.url), agent.request(server.url)]);

		const requests = await requestPromises;
		t.not(requests[0].session, requests[1].session);

		agent.destroy();
	});

	test('prevents overloading sessions #2', singleRequestWrapper, async (t, server) => {
		const secondServer = await createServer();
		const agent = new Agent({
			maxSessions: 1
		});

		secondServer.on('session', session => {
			session.origin(server.url);
		});
		await secondServer.listen();

		const session = await agent.getSession(server.url);
		const request = session.request();

		const secondSessionPromise = agent.getSession(server.url);

		const thirdSession = await agent.getSession(secondServer.url);

		const secondSession = await secondSessionPromise;
		t.is(secondSession, thirdSession);

		t.true(session.closed);
		t.false(session.destroyed);

		t.false(thirdSession.closed);
		t.false(thirdSession.destroyed);

		request.close();
		agent.closeFreeSessions();

		await secondServer.close();
	});

	test.only('prevents session overloading #3', singleRequestWrapper, async (t, server) => {
		const agent = new Agent({
			maxSessions: 1
		});

		const serverSessionAPromise = pEvent(server, 'session');
		const sessionA = await agent.getSession(server.url);
		const serverSessionA = await serverSessionAPromise;

		sessionA.request();

		const sessionBPromise = agent.getSession(server.url);

		serverSessionA.settings({
			maxConcurrentStreams: 2
		});

		console.log('awaiting');
		const sessionB = await sessionBPromise;

		t.is(sessionA, sessionB);

		agent.destroy();
	});

	test('sessions can be manually overloaded', singleRequestWrapper, async (t, server) => {
		const agent = new Agent();

		const session = await agent.getSession(server.url);
		const requests = [session.request(), session.request()];

		t.is(requests[0].session, requests[1].session);

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

	if (supportsTlsSessions) {
		test('caches a TLS session when successfully connected', wrapper, async (t, server) => {
			const agent = new Agent();

			await agent.getSession(server.url);
			await setImmediateAsync();

			t.true(is.buffer(agent.tlsSessionCache.get(`${Agent.normalizeAuthority(server.url)}:`).session));

			agent.destroy();
		});

		test('reuses a TLS session', wrapper, async (t, server) => {
			const agent = new Agent();
			const session = await agent.getSession(server.url);
			await setImmediateAsync();

			const tlsSession = agent.tlsSessionCache.get(`${Agent.normalizeAuthority(server.url)}:`).session;

			session.close();
			await pEvent(session, 'close');

			const secondSession = await agent.getSession(server.url);
			await setImmediateAsync();

			t.deepEqual(secondSession.socket.getSession(), tlsSession);
			t.true(is.buffer(tlsSession));

			agent.destroy();
		});

		test('purges the TLS session cache on session error', wrapper, async (t, server) => {
			const agent = new Agent();
			agent.once('error', () => {});

			const session = await agent.getSession(server.url);
			await setImmediateAsync();

			t.true(is.buffer(agent.tlsSessionCache.get(`${Agent.normalizeAuthority(server.url)}:`).session));

			session.destroy(new Error(message));
			await pEvent(session, 'close', {rejectionEvents: []});

			t.true(is.undefined(agent.tlsSessionCache.get(`${Agent.normalizeAuthority(server.url)}:`)));

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
		t.false(secondSession.closed);

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
		const request = await agent.request(server.url);

		const secondSession = await agent.getSession(secondServer.url);
		await pEvent(secondSession, 'origin');

		t.true(firstSession.closed);
		t.false(secondSession.closed);

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

		const request = await agent.request(server.url);
		const secondRequest = await agent.request(secondServer.url);
		const {session} = request;
		const secondSession = secondRequest.session;

		t.not(session, secondSession);
		t.false(session.closed);
		t.false(session.destroyed);
		t.false(secondSession.closed);
		t.false(secondSession.destroyed);

		request.close();

		await setImmediateAsync();

		t.false(session.closed);
		t.false(session.destroyed);
		t.true(secondSession.closed);
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
				requests.push(session.request());
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

		const request = await agent.request(server.url);
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

		t.true(agent.freeSessions[''][0].destroyed);

		agent.destroy();
	});

	test('`.freeSessions` may contain closed sessions', wrapper, async (t, server) => {
		const agent = new Agent();
		const session = await agent.getSession(server.url);
		session.close();

		t.true(agent.freeSessions[''][0].closed);

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

	test.serial('respects `.maxFreeSessions` changes', singleRequestWrapper, async (t, server) => {
		const agent = new Agent({
			maxFreeSessions: 2
		});

		const stream = await agent.request(server.url);
		const streamSession = stream.session;

		agent.maxFreeSessions = 1;
		stream.close();

		const session = await agent.getSession(server.url);
		t.is(session, streamSession);

		await pEvent(agent, 'close');

		agent.destroy();
	});

	test('destroying causes pending sessions to throw', wrapper, async (t, server) => {
		const agent = new Agent();
		const sessionPromise = agent.getSession(server.url);

		agent.destroy();

		await t.throwsAsync(sessionPromise, 'Agent has been destroyed');
	});

	test('newly queued sessions should not throw after `agent.destroy()`', wrapper, async (t, server) => {
		const agent = new Agent();
		const sessionPromise = agent.getSession(server.url);
		agent.destroy();

		await t.throwsAsync(sessionPromise, 'Agent has been destroyed');
		await t.notThrowsAsync(agent.getSession(server.url));

		agent.destroy();
	});

	test('`session` event', wrapper, async (t, server) => {
		const agent = new Agent();

		let called = false;
		agent.once('session', session => {
			called = true;

			t.false(session.closed);
		});

		await agent.getSession(server.url);
		t.true(called);

		agent.destroy();
	});

	test('`close` event', wrapper, async (t, server) => {
		const agent = new Agent({maxFreeSessions: 0});

		let called = false;
		agent.once('close', session => {
			called = true;

			t.true(session.closed);
		});

		(await agent.request(server.url)).close();

		await setImmediateAsync();

		t.true(called);

		agent.destroy();
	});

	test('`free` event', singleRequestWrapper, async (t, server) => {
		const agent = new Agent();

		let called = false;
		agent.once('free', session => {
			called = true;

			t.false(session.closed);
		});

		await agent.request(server.url);
		t.true(called);

		agent.destroy();
	});

	test('`busy` event', singleRequestWrapper, async (t, server) => {
		const agent = new Agent();

		let called = false;
		agent.once('busy', session => {
			called = true;

			t.false(session.closed);
		});

		await agent.request(server.url);
		t.true(called);

		agent.destroy();
	});

	test.failing('sessions can become suddenly covered by shrinking their current streams count', singleRequestWrapper, async (t, server) => {
		const agent = new Agent({
			maxFreeSessions: 2
		});

		const serverSessionAPromise = pEvent(server, 'session');
		const sessionA = await agent.getSession(server.url);
		const serverSessionA = await serverSessionAPromise;

		serverSessionA.origin('https://example.com');
		await pEvent(sessionA, 'origin');

		sessionA.request();

		const sessionB = await agent.getSession(server.url);
		const requestB = sessionB.request();

		requestB.close();

		t.true(sessionB.closed);

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

		sessionA.request();

		const sessionB = await agent.getSession(server.url);

		serverSessionA.settings({
			maxConcurrentStreams: 2
		});

		await pEvent(sessionA, 'remoteSettings');

		t.true(sessionB.closed);

		agent.destroy();
	});
}
