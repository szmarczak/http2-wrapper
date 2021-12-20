const {promisify} = require('util');
const {pipeline, PassThrough} = require('stream');
// eslint-disable-next-line ava/use-test
const {serial: test} = require('ava');
const pEvent = require('p-event');
const getStream = require('get-stream');
const is = require('@sindresorhus/is');
const {request: makeRequest, globalAgent} = require('../source/index.js');
const IncomingMessage = require('../source/incoming-message.js');
const {createWrapper} = require('./helpers/server.js');

test.serial = test;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const wrapper = createWrapper({
	beforeServerClose: () => globalAgent.destroy()
});

const intervalMs = 250;
const intervalHandler = (request, response) => {
	let i = 0;

	response.writeHead(200);
	response.write(i.toString());

	const interval = setInterval(() => {
		i++;
		response.write(i.toString());
	}, intervalMs);

	request.socket.once('close', () => {
		clearInterval(interval);
	});
};

test('properties', wrapper, async (t, server) => {
	const request = makeRequest(server.url);
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	t.true(is.plainObject(response.headers));
	t.true(is.array(response.rawHeaders));
	t.true(is.plainObject(response.trailers));
	t.true(is.array(response.rawTrailers));
	t.is(request.socket, request.connection);
	t.is(response.socket, request.socket);
	t.is(response.connection, request.socket);
	t.truthy(response.req);
	t.is(response.httpVersion, '2.0');
	t.is(response.httpVersionMajor, 2);
	t.is(response.httpVersionMinor, 0);
	t.true(is.number(response.statusCode));
	t.is(response.statusMessage, '');
});

test('`.destroy()` works', wrapper, async (t, server) => {
	const message = 'Simple error';

	const request = makeRequest(server.url);
	request.end();

	const response = await pEvent(request, 'response');
	response.destroy(new Error(message));

	const error = await pEvent(request, 'error');
	t.true(response.aborted);
	t.is(error.message, message);
	t.true(response.req._request.destroyed);
});

test('aborting dumps the response', wrapper, async (t, server) => {
	const request = makeRequest(server.url);
	request.end();

	const response = await pEvent(request, 'response');
	response.on('data', () => {});
	request.abort();

	response.once('end', () => {
		t.fail('Response emitted `end` event');
	});

	await pEvent(response, 'aborted');

	t.is(response.listenerCount('data'), 0);
	t.true(response._dumped);
});

test('`aborted` event', wrapper, async (t, server) => {
	server.post('/', (_request, response) => {
		response.write('asdf');

		setTimeout(() => {
			response.destroy();
		}, 100);
	});

	const request = makeRequest(server.url);
	request.method = 'POST';
	request.flushHeaders();

	const response = await pEvent(request, 'response');

	response.once('end', () => {
		t.fail('Response emitted `end`');
	});

	const promises = [
		pEvent(response, 'aborted')
	];

	await promises;

	t.pass();
});

test('`aborted` is not emitted on completed response', wrapper, async (t, server) => {
	const request = makeRequest(server.url);
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	response.on('aborted', () => {
		t.fail('`aborted` was emitted');
	});

	await new Promise(resolve => {
		response.on('end', () => {
			request.abort();

			process.nextTick(resolve);
		});
	});

	t.pass();
});

test.serial('`.setTimeout()` works', wrapper.lolex, async (t, server, clock) => {
	server.get('/headers-only', (request, response) => {
		response.writeHead(200);
	});

	const request = makeRequest(`${server.url}/headers-only`);
	request.end();

	const response = await pEvent(request, 'response');
	response.setTimeout(1, () => request.abort());

	const promise = pEvent(response, 'aborted');

	clock.tick(1);

	await promise;

	t.pass();
});

test('dumps the response if no listener attached', wrapper, async (t, server) => {
	const request = makeRequest(server.url);
	request.end();

	const responsePromise = new Promise(resolve => {
		const interval = setInterval(() => {
			if (request.res) {
				clearInterval(interval);
				resolve();
			}
		}, 100);
	});

	await responsePromise;

	t.true(request.res._dumped);
});

test('pausing & resuming', wrapper, async (t, server) => {
	const chunks = [];
	server.get('/interval', intervalHandler);

	const request = makeRequest(`${server.url}/interval`);
	request.end();

	const response = await pEvent(request, 'response');
	response.setEncoding('utf8');
	response.on('data', chunk => {
		chunks.push(chunk);
	});

	await pEvent(response, 'data');
	response.pause();

	const run = () => new Promise(resolve => {
		const interval = setInterval(async () => {
			if (response.readableLength === 2) {
				response.resume();

				await pEvent(response, 'data');
				t.deepEqual(chunks, ['0', '1', '2']);

				request.abort();
				clearInterval(interval);
				resolve();
			}
		});
	});

	await run();
});

test('reading parts of the response', wrapper, async (t, server) => {
	t.plan(3);

	server.get('/interval', intervalHandler);

	const request = makeRequest(`${server.url}/interval`);
	request.end();

	const response = await pEvent(request, 'response');
	response.setEncoding('utf8');
	await pEvent(response, 'readable');

	t.is(response.read(1), '0');

	const run = () => new Promise(resolve => {
		const interval = setInterval(() => {
			if (response.readableLength === 2) {
				t.is(response.read(1), '1');
				t.is(response.read(1), '2');

				request.abort();
				clearInterval(interval);
				resolve();
			}
		});
	});

	await run();
});

test('headers', wrapper, async (t, server) => {
	const request = makeRequest(server.url);
	request.end();

	const response = await pEvent(request, 'response');
	await getStream(response);

	t.false(is.emptyObject(response.headers));
	t.false(is.emptyArray(response.rawHeaders));
});

test('trailers', wrapper, async (t, server) => {
	server.get('/trailers', (request, response) => {
		response.addTrailers({
			foo: 'bar'
		});

		response.end('');
	});

	const request = makeRequest(`${server.url}/trailers`);
	request.end();

	const response = await pEvent(request, 'response');
	await getStream(response);

	t.is(response.trailers.foo, 'bar');

	t.deepEqual(response.rawTrailers, ['foo', 'bar']);
});

test('dumps only once', t => {
	const incoming = new IncomingMessage();
	incoming._dump();
	incoming.on('data', () => {});
	incoming._dump();

	t.is(incoming.listenerCount('data'), 1);
});

test('`end` event', wrapper, async (t, server) => {
	const request = makeRequest(server.url);
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	await pEvent(response, 'end');

	// Auto destroy is on
	t.true(response.destroyed);
});

test('response exceeds the highWaterMark size', wrapper, async (t, server) => {
	t.plan(2);

	const bigPayload = Buffer.alloc(1024 * 16 * 3);

	server.get('/', (_request, response) => {
		response.end(bigPayload);
	});

	const request = makeRequest(server.url);
	request.end();

	const response = await pEvent(request, 'response');

	const readableListener = () => {
		if (response.readableLength === response.readableHighWaterMark) {
			response.removeListener('readable', readableListener);

			t.true(request._request.isPaused());

			response.read();

			t.false(request._request.isPaused());

			response.resume();
		}
	};

	response.on('readable', readableListener);

	await pEvent(response, 'end');
});

test('`request.abort()` does not affect completed responses', wrapper, async (t, server) => {
	const request = makeRequest(server.url);
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	await pEvent(response, 'end');

	request.abort();

	t.false(request.aborted);
	t.is(typeof request.destroyed, 'boolean');
});

test('pipeline works', wrapper, async (t, server) => {
	const responseCopy = new PassThrough();

	const request = makeRequest(server.url).end();
	const response = await pEvent(request, 'response');

	await promisify(pipeline)(response, responseCopy);

	t.false(request.aborted);
	t.is(typeof request.destroyed, 'boolean');
});

test('.connection is .socket', t => {
	const response = new IncomingMessage();
	response.connection = 123;

	t.is(response.socket, 123);
});

test('`close` event is emitted', wrapper, async (t, server) => {
	const request = makeRequest(server.url);
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	await pEvent(response, 'close');

	t.pass();
});

test('HEADERS with END_STREAM (aka trailers)', wrapper, async (t, server) => {
	server.get('/', (requets, response) => {
		response.writeContinue();
		response.end();
	});

	const request = makeRequest(server.url);
	request.end();

	const response = await pEvent(request, 'response');
	response.resume();

	t.is(response.statusCode, 200);
	t.truthy(response.headers.date);

	await pEvent(response, 'end');
});
