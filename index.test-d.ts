/* eslint-disable no-new */
import {URL} from 'node:url';
import {TLSSocket, connect, ConnectionOptions} from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import {expectType, expectAssignable} from 'tsd';
import QuickLRU from 'quick-lru';
import http2 from './index.js';

expectType<http2.Agent>(http2.globalAgent);
expectType<typeof http.ClientRequest>(http2.ClientRequest);
expectType<typeof http.IncomingMessage>(http2.IncomingMessage);

const methods = [
	'request',
	'get'
] as const;

for (const method of methods) {
	{
		const request = http2[method]('https://example.com');

		expectType<http.ClientRequest>(request);

		request.once('response', response => {
			expectType<http.IncomingMessage>(response);
			response.resume();
		});

		if (method !== 'get') {
			request.end();
		}
	}

	{
		const request = http2[method]('https://example.com', response => {
			expectType<http.IncomingMessage>(response);
			response.resume();
		});

		expectType<http.ClientRequest>(request);

		if (method !== 'get') {
			request.end();
		}
	}

	{
		const request = http2[method]({
			protocol: 'https:',
			hostname: 'example.com'
		}, response => {
			expectType<http.IncomingMessage>(response);
			response.resume();
		});

		expectType<http.ClientRequest>(request);

		if (method !== 'get') {
			request.end();
		}
	}

	{
		const request = http2[method]({
			protocol: 'https:',
			hostname: 'example.com'
		}, response => {
			expectType<http.IncomingMessage>(response);
			response.resume();
		});

		expectType<http.ClientRequest>(request);

		if (method !== 'get') {
			request.end();
		}
	}

	{
		const request = http2[method]('https://httpbin.org', {
			path: '/anything'
		}, response => {
			expectType<http.IncomingMessage>(response);
			response.resume();
		});

		expectType<http.ClientRequest>(request);

		if (method !== 'get') {
			request.end();
		}
	}

	{
		const request = http2[method]('https://example.com', {
			agent: new http2.Agent()
		});

		request.destroy();
	}

	{
		const request = http2[method]('https://example.com', {
			agent: false
		});

		request.destroy();
	}

	{
		const request = http2[method]('https://example.com', {
			ALPNProtocols: ['h2']
		});

		expectType<http.ClientRequest>(request);

		request.once('response', response => {
			expectType<http.IncomingMessage>(response);
			response.resume();
		});

		if (method !== 'get') {
			request.end();
		}
	}
}

(async () => {
	(await http2.auto('https://example.com', {
		agent: {
			http: false
		}
	})).end();

	(await http2.auto('https://example.com', {
		agent: {
			https: false
		}
	})).end();

	(await http2.auto('https://example.com', {
		agent: {
			http2: false
		}
	})).end();

	(await http2.auto('https://example.com', {
		agent: {
			http: false,
			https: false,
			http2: false
		}
	})).end();

	(await http2.auto('https://example.com', {
		agent: {}
	})).end();

	(await http2.auto('https://example.com', {
		agent: {
			http: new http.Agent()
		}
	})).end();

	(await http2.auto('https://example.com', {
		agent: {
			http: new http.Agent(),
			https: new https.Agent()
		}
	})).end();

	(await http2.auto('https://example.com', {
		agent: {
			https: new https.Agent(),
			http2: new http2.Agent()
		}
	})).end();

	(await http2.auto('https://example.com', {
		agent: {
			http: new http.Agent(),
			https: new https.Agent(),
			http2: new http2.Agent()
		}
	})).end();

	{
		const request = await http2.auto('https://example.com');

		expectType<http.ClientRequest>(request);

		request.once('response', response => {
			expectType<http.IncomingMessage>(response);
			response.resume();
		});
	}

	{
		const request = await http2.auto('https://example.com', response => {
			expectType<http.IncomingMessage>(response);
			response.resume();
		});

		expectType<http.ClientRequest>(request);
	}

	{
		const request = await http2.auto({
			protocol: 'https:',
			hostname: 'example.com'
		}, response => {
			expectType<http.IncomingMessage>(response);
			response.resume();
		});

		expectType<http.ClientRequest>(request);
	}

	{
		const request = await http2.auto({
			protocol: 'https:',
			hostname: 'example.com'
		}, response => {
			expectType<http.IncomingMessage>(response);
			response.resume();
		});

		expectType<http.ClientRequest>(request);
	}

	{
		const request = await http2.auto('https://httpbin.org', {
			path: '/anything'
		}, response => {
			expectType<http.IncomingMessage>(response);
			response.resume();
		});

		expectType<http.ClientRequest>(request);
	}

	{
		const request = await http2.auto('https://httpbin.org', {
			ALPNProtocols: ['h2']
		}, response => {
			expectType<http.IncomingMessage>(response);
			response.resume();
		});

		expectType<http.ClientRequest>(request);
	}

	new http2.Agent();
	new http2.Agent({});
	const agent = new http2.Agent({
		timeout: 1000,
		maxSessions: 1,
		maxEmptySessions: 0,
		maxCachedTlsSessions: 10
	});

	const session = await agent.getSession('https://example.com');
	expectType<http2.ClientHttp2Session>(session);

	const request = await agent.request('https://example.com');
	expectType<http2.ClientHttp2Stream>(request);

	request.destroy();
	session.destroy();

	expectType<number>(agent.sessionCount);
	expectType<number>(agent.emptySessionCount);
	expectType<number>(agent.pendingSessionCount);

	agent.closeEmptySessions();
	agent.closeEmptySessions(1);

	expectType<number>(agent.timeout);
	expectType<number>(agent.maxEmptySessions);
	expectType<string>(agent.protocol);
	expectType<number>(agent.maxSessions);
	expectType<http2.Settings>(agent.settings);
	expectType<QuickLRU<string, string>>(agent.tlsSessionCache);
	expectType<Record<string, http2.ClientHttp2Session[]>>(agent.sessions);
	expectType<Record<string, Record<string, http2.EntryFunction>>>(agent.queue);

	expectType<boolean>(agent.queue['']['https://example.com'].completed);
	expectType<boolean>(agent.queue['']['https://example.com'].destroyed);
	expectType<http2.PromiseListeners>(agent.queue['']['https://example.com'].listeners);

	expectType<string>(agent.normalizeOptions({}));
	expectType<TLSSocket>(await agent.createConnection(new URL('https://example.com'), {}));
	expectType<TLSSocket>(http2.Agent.connect(new URL('https://example.com'), {}));

	agent.destroy();
	agent.destroy(new Error('Have a good day!'));

	const fns = [
		http2.auto.createResolveProtocol(new Map(), new Map()),
		http2.auto.createResolveProtocol(new Map(), new Map(), connect),
		http2.auto.createResolveProtocol(new Map(), new Map(), async (options: ConnectionOptions, callback: () => void) => {
			return connect(options, callback);
		})
	];

	for (const fn of fns) {
		// eslint-disable-next-line no-await-in-loop
		const request = await http2.auto('https://example.com', {
			resolveProtocol: fn
		}, response => {
			response.resume();
		});

		request.end();
	}
})();

expectAssignable<typeof http.Agent>(http2.proxies.HttpOverHttp2);
expectAssignable<typeof https.Agent>(http2.proxies.HttpsOverHttp2);
expectAssignable<typeof http2.Agent>(http2.proxies.Http2OverHttp2);
expectAssignable<typeof http2.Agent>(http2.proxies.Http2OverHttp);
expectAssignable<typeof http2.Agent>(http2.proxies.Http2OverHttps);

const agents = [
	http2.proxies.HttpOverHttp2,
	http2.proxies.HttpsOverHttp2,
	http2.proxies.Http2OverHttp2,
	http2.proxies.Http2OverHttp,
	http2.proxies.Http2OverHttps
] as const;

for (const Agent of agents) {
	new Agent({
		proxyOptions: {
			url: 'https://example.com'
		}
	});

	new Agent({
		proxyOptions: {
			url: 'https://example.com',
			headers: {}
		}
	});

	new Agent({
		proxyOptions: {
			url: 'https://example.com',
			raw: false
		}
	});

	new Agent({
		proxyOptions: {
			url: 'https://example.com',
			headers: {
				foobar: 'unicorn'
			}
		}
	});

	new Agent({
		proxyOptions: {
			url: 'https://example.com',
			headers: {
				foobar: 'unicorn'
			},
			raw: false
		}
	});
}
