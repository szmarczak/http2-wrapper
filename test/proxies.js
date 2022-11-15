const http = require('http');
const https = require('https');
const test = require('ava');
const pEvent = require('p-event');
const getStream = require('get-stream');
const http2 = require('../source/index.js');
const createProxyServer = require('../proxy-server.js');
const {createWrapper} = require('./helpers/server.js');
const sslOptions = require('./helpers/certs.js');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const wrapper = createWrapper();

const authorize = (type, credentials) => {
	try {
		if (type !== 'basic') {
			return false;
		}

		const plain = Buffer.from(credentials, 'base64').toString();

		if (plain !== 'username:password') {
			return false;
		}
	} catch {
		return false;
	}
};

const runTestWithServer = (server, run) => new Promise((resolve, reject) => {
	server.listen(async error => {
		if (error) {
			reject(error);
			return;
		}

		try {
			await run();
		} catch (error) {
			reject(error);
		}

		server.close(error => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
});

test.serial('constructor', t => {
	[
		http2.proxies.HttpsOverHttp2,
		http2.proxies.HttpOverHttp2,
		http2.proxies.Http2OverHttp,
		http2.proxies.Http2OverHttps,
		http2.proxies.Http2OverHttp2
		// eslint-disable-next-line unicorn/no-array-for-each
	].forEach(Agent => {
		t.throws(() => new Agent({
			proxyOptions: false
		}), {
			message: 'Expected \'proxyOptions\' to be a type of object, got boolean'
		});

		t.throws(() => new Agent({
			proxyOptions: {}
		}), {
			message: 'Expected \'proxyOptions.url\' to be a type of URL or string, got undefined'
		});

		t.throws(() => new Agent({
			proxyOptions: {
				url: 'invalid'
			}
		}), {
			message: /Invalid URL/
		});

		t.notThrows(() => new Agent({
			proxyOptions: {
				url: new URL('https://not-invalid')
			}
		}));

		t.throws(() => new Agent({
			proxyOptions: {
				url: new URL('https://not-invalid'),
				raw: 123
			}
		}), {
			message: 'Expected \'proxyOptions.raw\' to be a type of boolean or undefined, got number'
		});

		t.notThrows(() => new Agent({
			proxyOptions: {
				url: new URL('https://not-invalid'),
				raw: true
			}
		}));

		t.throws(() => new Agent({
			proxyOptions: {
				url: new URL('https://not-invalid'),
				headers: 123
			}
		}), {
			message: 'Expected \'proxyOptions.headers\' to be a type of object or undefined, got number'
		});

		t.notThrows(() => new Agent({
			proxyOptions: {
				url: new URL('https://not-invalid'),
				headers: {}
			}
		}));
	});
});

// ============================ HTTPS over HTTP/2 ============================

test.serial('HTTPS over HTTP/2 - 200', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.HttpsOverHttp2({
		proxyOptions: {
			url: new URL('https://username:password@localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = https.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		http2.globalAgent.destroy();
	});

	t.pass();
});

test.serial('extremely insecure HTTPS over HTTP/2 - 200', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.HttpsOverHttp2({
		proxyOptions: {
			url: new URL('https://username:password@localhost'),
			raw: false,
			headers: {
				'alpn-protocols': 'http/1.1'
			}
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = https.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		http2.globalAgent.destroy();
	});

	t.pass();
});

test.serial('extremely insecure HTTPS over HTTP/2 - incorrect `raw` property', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.HttpsOverHttp2({
		proxyOptions: {
			url: new URL('https://username:password@localhost'),
			raw: true,
			headers: {
				'alpn-protocols': 'http/1.1'
			}
		}
	});

	await t.throwsAsync(runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = https.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		http2.globalAgent.destroy();
	}), {
		message: /^write EPROTO/
	});
});

test.serial('HTTPS over HTTP/2 - 403', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.HttpsOverHttp2({
		proxyOptions: {
			url: new URL('https://localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = https.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		const error = await pEvent(request, 'error');
		t.is(error.message, 'The proxy server rejected the request with status code 403 (empty status message)');

		http2.globalAgent.destroy();
	});
});

test.serial('HTTPS over HTTP/2 - proxy does not exist', wrapper, async (t, server) => {
	const agent = new http2.proxies.HttpsOverHttp2({
		proxyOptions: {
			url: new URL('https://localhost')
		}
	});

	const request = https.request(`https://localhost:${server.address().port}`, {
		agent
	});
	request.end();

	const error = await pEvent(request, 'error');
	t.regex(error.message, /^connect ECONNREFUSED (127\.0\.0\.1|::1):443$/);
});

// ============================ HTTP over HTTP/2 ============================

test.serial('HTTP over HTTP/2 - 200', async t => {
	const server = http.createServer((request, response) => {
		response.end('{}');
	});

	server.listen();
	await pEvent(server, 'listening');

	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.HttpOverHttp2({
		proxyOptions: {
			url: new URL('https://username:password@localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http.request(`http://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		http2.globalAgent.destroy();
	});

	t.pass();

	server.close();
	await pEvent(server, 'close');
});

test.serial('HTTP over HTTP/2 - 403', async t => {
	const server = http.createServer((request, response) => {
		response.end('{}');
	});

	server.listen();
	await pEvent(server, 'listening');

	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.HttpOverHttp2({
		proxyOptions: {
			url: new URL('https://localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http.request(`http://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		const error = await pEvent(request, 'error');
		t.is(error.message, 'The proxy server rejected the request with status code 403 (empty status message)');

		http2.globalAgent.destroy();
	});

	t.pass();

	server.close();
	await pEvent(server, 'close');
});

test.serial('HTTP over HTTP/2 - proxy does not exist', wrapper, async (t, server) => {
	const agent = new http2.proxies.HttpOverHttp2({
		proxyOptions: {
			url: new URL('https://localhost')
		}
	});

	const request = http.request(`http://localhost:${server.address().port}`, {
		agent
	});
	request.end();

	const error = await pEvent(request, 'error');
	t.regex(error.message, /^connect ECONNREFUSED (127\.0\.0\.1|::1):443$/);
});

// ============================ HTTP/2 over HTTPS ============================

test.serial('HTTP/2 over HTTPS - 200', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.Http2OverHttps({
		proxyOptions: {
			url: new URL('https://username:password@localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http2.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		agent.destroy();
		http2.globalAgent.destroy();
	});

	t.pass();
});

test.serial('extremely insecure HTTP/2 over HTTPS - 200', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.Http2OverHttps({
		proxyOptions: {
			url: new URL('https://username:password@localhost'),
			raw: false,
			headers: {
				'alpn-protocols': 'h2'
			}
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http2.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		agent.destroy();
		http2.globalAgent.destroy();
	});

	t.pass();
});

test.serial('extremely insecure HTTP/2 over HTTPS - incorrect `raw` property', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.Http2OverHttps({
		proxyOptions: {
			url: new URL('https://username:password@localhost'),
			raw: true,
			headers: {
				'alpn-protocols': 'h2'
			}
		}
	});

	await t.throwsAsync(runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http2.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		agent.destroy();
		http2.globalAgent.destroy();
	}), {
		code: 'ERR_SSL_WRONG_VERSION_NUMBER'
	});
});

test.serial('HTTP/2 over HTTPS - 403', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.Http2OverHttps({
		proxyOptions: {
			url: new URL('https://localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http2.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		const error = await pEvent(request, 'error');
		t.is(error.message, 'The proxy server rejected the request with status code 403 (Forbidden)');

		agent.destroy();
		http2.globalAgent.destroy();
	});

	t.pass();
});

test.serial('HTTP/2 over HTTPS - proxy does not exist', wrapper, async (t, server) => {
	const agent = new http2.proxies.Http2OverHttps({
		proxyOptions: {
			url: new URL('https://localhost')
		}
	});

	const request = http2.request(`https://localhost:${server.address().port}`, {
		agent
	});
	request.end();

	const error = await pEvent(request, 'error');
	t.regex(error.message, /^connect ECONNREFUSED (127\.0\.0\.1|::1):443$/);
});

// ============================ HTTP/2 over HTTP ============================

test.serial('HTTP/2 over HTTP - 200', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		authorize
	});

	const agent = new http2.proxies.Http2OverHttp({
		proxyOptions: {
			url: new URL('http://username:password@localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http2.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		agent.destroy();
		http2.globalAgent.destroy();
	});

	t.pass();
});

test.serial('extremely insecure HTTP/2 over HTTP - 200', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		authorize
	});

	const agent = new http2.proxies.Http2OverHttp({
		proxyOptions: {
			url: new URL('http://username:password@localhost'),
			raw: false,
			headers: {
				'alpn-protocols': 'h2'
			}
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http2.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		agent.destroy();
		http2.globalAgent.destroy();
	});

	t.pass();
});

test.serial('extremely insecure HTTP/2 over HTTP - incorrect `raw` property', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		authorize
	});

	const agent = new http2.proxies.Http2OverHttp({
		proxyOptions: {
			url: new URL('http://username:password@localhost'),
			raw: true,
			headers: {
				'alpn-protocols': 'h2'
			}
		}
	});

	await t.throwsAsync(runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http2.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		agent.destroy();
		http2.globalAgent.destroy();
	}), {
		code: 'ERR_SSL_WRONG_VERSION_NUMBER'
	});
});

test.serial('HTTP/2 over HTTP - 403', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		authorize
	});

	const agent = new http2.proxies.Http2OverHttp({
		proxyOptions: {
			url: new URL('http://localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http2.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		const error = await pEvent(request, 'error');
		t.is(error.message, 'The proxy server rejected the request with status code 403 (Forbidden)');

		agent.destroy();
		http2.globalAgent.destroy();
	});

	t.pass();
});

test.serial('HTTP/2 over HTTP - proxy does not exist', wrapper, async (t, server) => {
	// GitHub Actions container has an HTTP server on 80 on Windows for some reason.
	const agent = new http2.proxies.Http2OverHttp({
		proxyOptions: {
			url: new URL('http://localhost:443')
		}
	});

	const request = http2.request(`https://localhost:${server.address().port}`, {
		agent
	});
	request.end();

	const error = await pEvent(request, 'error');
	t.regex(error.message, /^connect ECONNREFUSED (127\.0\.0\.1|::1):443$/);
});

// ============================ HTTP/2 over HTTP/2 ============================

test.serial('HTTP/2 over HTTP/2 - 200', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.Http2OverHttp2({
		proxyOptions: {
			url: new URL('https://username:password@localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http2.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		http2.globalAgent.destroy();
	});

	t.pass();
});

test.serial('extremely insecure HTTP/2 over HTTP/2 - 200', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.Http2OverHttp2({
		proxyOptions: {
			url: new URL('https://username:password@localhost'),
			raw: false,
			headers: {
				'alpn-protocols': 'h2'
			}
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http2.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		http2.globalAgent.destroy();
	});

	t.pass();
});

test.serial('extremely insecure HTTP/2 over HTTP/2 - incorrect `raw` property', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.Http2OverHttp2({
		proxyOptions: {
			url: new URL('https://username:password@localhost'),
			raw: true,
			headers: {
				'alpn-protocols': 'h2'
			}
		}
	});

	await t.throwsAsync(runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http2.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		await pEvent(request, 'socket');
		t.is(proxyServer.proxiedCounter, 1);
		t.notThrows(() => request.socket.remoteAddress);
		t.is(typeof request.socket.encrypted, 'boolean');

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		http2.globalAgent.destroy();
	}), {
		code: 'ERR_SSL_WRONG_VERSION_NUMBER'
	});
});

test.serial('HTTP/2 over HTTP/2 - 403', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const agent = new http2.proxies.Http2OverHttp2({
		proxyOptions: {
			url: new URL('https://localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		agent.proxyOptions.url.port = proxyServer.address().port;

		const request = http2.request(`https://localhost:${server.address().port}`, {
			agent
		});
		request.end();

		const error = await pEvent(request, 'error');
		t.is(error.message, 'The proxy server rejected the request with status code 403 (empty status message)');

		http2.globalAgent.destroy();
	});
});

test.serial('HTTP/2 over HTTP/2 - proxy does not exist', wrapper, async (t, server) => {
	const agent = new http2.proxies.Http2OverHttp2({
		proxyOptions: {
			url: new URL('https://localhost')
		}
	});

	const request = http2.request(`https://localhost:${server.address().port}`, {
		agent
	});
	request.end();

	const error = await pEvent(request, 'error');
	t.regex(error.message, /^connect ECONNREFUSED (127\.0\.0\.1|::1):443$/);
});
