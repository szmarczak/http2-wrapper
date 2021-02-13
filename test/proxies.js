const test = require('ava');
const http = require('http');
const https = require('https');
const pEvent = require('p-event');
const getStream = require('get-stream');
const http2 = require('../source');
const createProxyServer = require('../proxy-server');
const {createWrapper} = require('./helpers/server');
const sslOptions = require('./helpers/certs');

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

test.serial('HTTPS over HTTP/2 - 200', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const raw = new http2.proxies.HttpsOverHttp2({
		proxyOptions: {
			url: new URL('https://username:password@localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		raw.proxyOptions.url.port = proxyServer.address().port;

		const request = https.request(`https://localhost:${server.address().port}`, {
			agent: raw
		});
		request.end();

		const response = await pEvent(request, 'response');
		const body = await getStream(response);

		t.is(response.statusCode, 200);
		t.notThrows(() => JSON.parse(body));

		http2.globalAgent.destroy();
	});

	t.pass();
});

test.serial('HTTPS over HTTP/2 - 403', wrapper, async (t, server) => {
	const proxyServer = createProxyServer({
		...sslOptions,
		authorize
	});

	const raw = new http2.proxies.HttpsOverHttp2({
		proxyOptions: {
			url: new URL('https://localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		raw.proxyOptions.url.port = proxyServer.address().port;

		const request = https.request(`https://localhost:${server.address().port}`, {
			agent: raw
		});
		request.end();

		const error = await pEvent(request, 'error');
		t.is(error.message, 'The proxy server rejected the request with status code 403');

		http2.globalAgent.destroy();
	});
});

test.serial('HTTPS over HTTP/2 - proxy does not exist', wrapper, async (t, server) => {
	const raw = new http2.proxies.HttpsOverHttp2({
		proxyOptions: {
			url: new URL('https://localhost')
		}
	});

	const request = https.request(`https://localhost:${server.address().port}`, {
		agent: raw
	});
	request.end();

	const error = await pEvent(request, 'error');
	t.is(error.message, 'connect ECONNREFUSED 127.0.0.1:443');
});

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

	const raw = new http2.proxies.HttpOverHttp2({
		proxyOptions: {
			url: new URL('https://username:password@localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		raw.proxyOptions.url.port = proxyServer.address().port;

		const request = http.request(`http://localhost:${server.address().port}`, {
			agent: raw
		});
		request.end();

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

	const raw = new http2.proxies.HttpOverHttp2({
		proxyOptions: {
			url: new URL('https://localhost')
		}
	});

	await runTestWithServer(proxyServer, async () => {
		raw.proxyOptions.url.port = proxyServer.address().port;

		const request = http.request(`http://localhost:${server.address().port}`, {
			agent: raw
		});
		request.end();

		const error = await pEvent(request, 'error');
		t.is(error.message, 'The proxy server rejected the request with status code 403');

		http2.globalAgent.destroy();
	});

	t.pass();

	server.close();
	await pEvent(server, 'close');
});

test.serial('HTTP over HTTP/2 - proxy does not exist', wrapper, async (t, server) => {
	const raw = new http2.proxies.HttpOverHttp2({
		proxyOptions: {
			url: new URL('https://localhost')
		}
	});

	const request = http.request(`http://localhost:${server.address().port}`, {
		agent: raw
	});
	request.end();

	const error = await pEvent(request, 'error');
	t.is(error.message, 'connect ECONNREFUSED 127.0.0.1:443');
});
