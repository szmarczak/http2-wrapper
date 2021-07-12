const test = require('ava');
const got = require('got');
const http2 = require('../source/index.js');
const {createWrapper} = require('./helpers/server.js');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const wrapper = createWrapper({
	beforeServerClose: () => http2.globalAgent.destroy()
});

test('cache works', wrapper, async (t, server) => {
	const etag = 'foobar';

	server.get('/', (request, response) => {
		if (request.headers['if-none-match'] === etag) {
			response.statusCode = 304;
			response.end();
		} else {
			response.setHeader('etag', etag);
			response.end(etag);
		}
	});

	const cache = new Map();

	const options = {request: http2.auto, cache};
	const first = await got(server.url, options);
	const second = await got(server.url, options);

	t.false(first.isFromCache);
	t.true(second.isFromCache);

	t.is(first.body, second.body);
	t.is(first.body, etag);
});
