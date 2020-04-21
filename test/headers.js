// eslint-disable-next-line ava/use-test
const {serial: test} = require('ava');
const pEvent = require('p-event');
const getStream = require('get-stream');
const http2 = require('../source');
const {createWrapper} = require('./helpers/server');

const {request: makeRequest} = http2;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const wrapper = createWrapper({
	beforeServerClose: () => http2.globalAgent.destroy()
});

test('setting headers', wrapper, async (t, server) => {
	const request = makeRequest(server.options);
	request.setHeader('foo', 'bar');
	request.end();

	const res = await pEvent(request, 'response');
	const data = JSON.parse(await getStream(res));
	t.is(data.headers.foo, 'bar');
});

test('`headers` option', wrapper, async (t, server) => {
	const request = makeRequest({...server.options, headers: {foo: 'bar'}});
	request.end();

	const res = await pEvent(request, 'response');
	const data = JSON.parse(await getStream(res));
	t.is(data.headers.foo, 'bar');
});

test('getting headers', wrapper, (t, server) => {
	const request = makeRequest(server.bar);
	request.setHeader('foo', 'bar');
	request.abort();

	t.is(request.getHeader('foo'), 'bar');
});

test('removing headers', wrapper, async (t, server) => {
	const request = makeRequest(server.options);
	request.setHeader('foo', 'bar');
	request.removeHeader('foo');
	request.end();

	const res = await pEvent(request, 'response');
	const data = JSON.parse(await getStream(res));
	t.is(data.headers.foo, undefined);
});

test('can\'t change headers after they are sent', wrapper, async (t, server) => {
	const request = makeRequest(server.options);
	request.end();

	await pEvent(request, 'finish');
	t.throws(() => request.setHeader('foo', 'bar'), {
		message: 'Cannot set headers after they are sent to the client'
	});
	t.throws(() => request.removeHeader('foo'), {
		message: 'Cannot remove headers after they are sent to the client'
	});

	request.abort();
});

test('invalid headers', t => {
	const request = makeRequest({});

	t.throws(() => request.setHeader(undefined, 'qwerty'), {
		message: 'Header name must be a valid HTTP token [undefined]'
	});
	t.throws(() => request.setHeader('qwerty', undefined), {
		message: 'Invalid value "undefined for header "qwerty"'
	});
	t.throws(() => request.setHeader('“', 'qwerty'), {
		message: 'Header name must be a valid HTTP token [“]'
	});
	t.throws(() => request.setHeader('qwerty', '“'), {
		message: 'Invalid character in header content [qwerty]'
	});

	t.throws(() => request.getHeader(undefined), {
		message: 'The "name" argument must be of type string. Received undefined'
	});

	t.throws(() => request.removeHeader(undefined), {
		message: 'The "name" argument must be of type string. Received undefined'
	});
});
