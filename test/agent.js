import {promisify} from 'util';
import tls from 'tls';
import test from 'ava';
import createCert from 'create-cert';
import pEvent from 'p-event';
import is from '@sindresorhus/is';
import {Agent} from '../source';
import isCompatible from '../source/utils/is-compatible';
import {createWrapper, createServer} from './helpers/server';

const supportsTlsSessions = process.versions.node.split('.')[0] >= 11;

const setImmediateAsync = () => new Promise(resolve => setImmediate(resolve));

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
	});

	test('gives free sessions if available', wrapper, async (t, server) => {
		const agent = new Agent();
		const first = await agent.getSession(server.url);

		t.is(Object.values(agent.freeSessions)[0].length, 1);

		const second = await agent.getSession(server.url);

		t.is(Object.values(agent.freeSessions)[0].length, 1);
		t.is(first, second);
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
	});

	test.serial('`timeout` option', wrapper, async (t, server) => {
		const timeout = 500;
		const agent = new Agent({timeout});

		const started = Date.now();
		const request = await agent.request(server.url);
		request.end().resume();

		t.is(Object.values(agent.freeSessions)[0].length, 1);

		request.once('socket', socket => {
			socket.once('close', () => {
				const now = Date.now();
				const difference = now - started;

				t.is(Object.values(agent.freeSessions).length, 0);
				t.true(difference <= timeout, `Timeout exceeded ${timeout}ms (${difference}ms)`);
			});
		});
	});

	test('`maxSessions` option', singleRequestWrapper, async (t, server) => {
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

	// This sometimes fails on Node < 12
	test('doesn\'t break on session `close` event', singleRequestWrapper, async (t, server) => {
		t.plan(2);

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
		t.pass();
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
		}

		{
			const agent = new Agent();
			const session = await agent.getSession(server.url);
			(await agent.request(server.url)).end();

			agent.closeFreeSessions();

			t.is(session.closed, false);
			t.is(Object.values(agent.freeSessions).length, 1);
		}
	});

	test('throws if session is closed before receiving a SETTINGS frame', async t => {
		const {key, cert} = await createCert();

		const server = tls.createServer({key, cert, ALPNProtocols: ['h2']}, socket => {
			setTimeout(() => socket.end(), 2000);
		});

		server.listen = promisify(server.listen.bind(server));
		server.close = promisify(server.close.bind(server));

		await server.listen();

		const agent = new Agent({
			timeout: 1000
		});

		await t.throwsAsync(
			agent.request(`https://localhost:${server.address().port}`),
			'Session closed without receiving a SETTINGS frame'
		);

		await server.close();
	});

	test('endless response', singleRequestWrapper, async (t, server) => {
		const agent = new Agent({
			timeout: 1000
		});

		const secondStream = await agent.request(server.url);
		await pEvent(secondStream, 'close');

		t.pass();
	});

	test('endless response (specific case)', singleRequestWrapper, async (t, server) => {
		const agent = new Agent();

		const firstRequest = await agent.request(server.url);
		const secondRequest = await agent.request(server.url);

		firstRequest.close();
		secondRequest.close();

		const secondStream = await agent.request(server.url);
		secondStream.session.destroy();
		await pEvent(secondStream, 'close');

		t.pass();
	});

	test('respects `.getName()`', wrapper, async (t, server) => {
		const agent = new Agent();

		const firstSession = await agent.getSession(server.url);
		const secondSession = await agent.getSession(server.url, {
			maxSessionMemory: 1
		});

		t.not(firstSession, secondSession);
	});

	test('custom servername', wrapper, async (t, server) => {
		const agent = new Agent();

		const session = await agent.getSession(server.url, {servername: 'foobar'});
		t.is(session.socket.servername, 'foobar');
	});

	test('appends to freeSessions after the stream has ended', singleRequestWrapper, async (t, server) => {
		t.plan(1);

		server.get('/', (request, response) => {
			setTimeout(() => {
				response.end();
			}, 200);
		});

		const agent = new Agent({maxFreeSessions: 2});

		const firstRequest = await agent.request(server.url);
		const secondRequest = await agent.request(server.url);

		firstRequest.close();
		secondRequest.close();

		const secondStream = await agent.request(server.url);
		secondStream.end();
		await pEvent(secondStream, 'close');

		setImmediate(() => {
			t.is(agent.freeSessions[''].length, 2);
		});
	});

	test('appends to freeSessions after the stream has ended #2', singleRequestWrapper, async (t, server) => {
		// TODO: get rid of `serverSession.setTimeout()` as it breaks this test
		server.get('/', (request, response) => {
			setTimeout(() => {
				response.end();
			}, 200);
		});

		const agent = new Agent({maxSessions: 1});

		const firstRequest = await agent.request(server.url);
		const secondRequestPromise = agent.request(server.url);

		firstRequest.close();

		const secondRequest = await secondRequestPromise;
		secondRequest.end();
		await pEvent(secondRequest, 'close');

		t.pass();
	});

	test('prevents overloading sessions', singleRequestWrapper, async (t, server) => {
		const agent = new Agent();

		const requestPromises = Promise.all([agent.request(server.url), agent.request(server.url)]);

		const requests = await requestPromises;
		t.not(requests[0].session, requests[1].session);
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
		await secondServer.gracefulClose();
	});

	test('sessions can be manually overloaded', singleRequestWrapper, async (t, server) => {
		const agent = new Agent();

		const session = await agent.getSession(server.url);
		const requests = [session.request(), session.request()];

		t.is(requests[0].session, requests[1].session);
	});

	test('emits `session` event when a new session is created', wrapper, async (t, server) => {
		t.plan(1);

		const agent = new Agent();

		agent.once('session', session => {
			t.truthy(session);
		});

		await agent.getSession(server.url);
	});

	test('`.settings` property', wrapper, async (t, server) => {
		const agent = new Agent();
		agent.settings.maxHeaderListSize = 100;

		const session = await agent.getSession(server.url);
		await pEvent(session, 'localSettings');

		t.is(session.localSettings.maxHeaderListSize, 100);
	});

	if (supportsTlsSessions) {
		test('caches a TLS session when successfully connected', wrapper, async (t, server) => {
			const agent = new Agent();

			await agent.getSession(server.url);
			await setImmediateAsync();

			t.true(is.buffer(agent.tlsSessionCache.get(`${agent.normalizeAuthority(server.url)}:`).session));
		});

		test('reuses a TLS session', wrapper, async (t, server) => {
			const agent = new Agent();
			const session = await agent.getSession(server.url);
			await setImmediateAsync();

			const tlsSession = agent.tlsSessionCache.get(`${agent.normalizeAuthority(server.url)}:`).session;

			session.close();
			await pEvent(session, 'close');

			const secondSession = await agent.getSession(server.url);
			await setImmediateAsync();

			t.deepEqual(secondSession.socket.getSession(), tlsSession);
			t.true(is.buffer(tlsSession));
		});

		test('purges the TLS session on session error', wrapper, async (t, server) => {
			const agent = new Agent();
			const session = await agent.getSession(server.url);
			await setImmediateAsync();

			t.true(is.buffer(agent.tlsSessionCache.get(`${agent.normalizeAuthority(server.url)}:`).session));

			session.destroy(new Error('Ouch.'));
			await pEvent(session, 'close', {rejectionEvents: []});

			t.true(is.undefined(agent.tlsSessionCache.get(`${agent.normalizeAuthority(server.url)}:`)));
		});
	}

	// eslint-disable-next-line ava/no-skip-test
	test.skip('throws on invalid usage', wrapper, async (t, server) => {
		const agent = new Agent();
		const session = await agent.getSession(server.url);

		t.throws(() => session.request(), 'Invalid usage. Use `await agent.request(authority, options, headers)` instead.');
	});

	test('doesn\'t create a new session if there exists an authoritive one', wrapper, async (t, server) => {
		server.on('session', session => {
			session.origin('https://example.com');
		});

		const agent = new Agent();

		const session = await agent.getSession(server.url);
		await pEvent(session, 'origin');

		t.is(await agent.getSession('https://example.com'), session);
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

		await secondServer.gracefulClose();
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

		await secondServer.gracefulClose();
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

		await secondServer.gracefulClose();
	});

	test('uses sessions which are more loaded to use fewer connections', tripleRequestWrapper, async (t, server) => {
		const SESSIONS_COUNT = 3;
		const REQUESTS_COUNT = 3;

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
				requests: generateRequests(session, REQUESTS_COUNT),
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
	});
}
