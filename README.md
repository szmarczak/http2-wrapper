# http2-wrapper
> HTTP2 client, just with the familiar `https` API

[![Build Status](https://travis-ci.org/szmarczak/http2-wrapper.svg?branch=master)](https://travis-ci.org/szmarczak/http2-wrapper)
[![Coverage Status](https://coveralls.io/repos/github/szmarczak/http2-wrapper/badge.svg?branch=master)](https://coveralls.io/github/szmarczak/http2-wrapper?branch=master)
[![npm](https://img.shields.io/npm/dm/http2-wrapper.svg)](https://www.npmjs.com/package/http2-wrapper)
[![install size](https://packagephobia.now.sh/badge?p=http2-wrapper)](https://packagephobia.now.sh/result?p=http2-wrapper)

This package was created to support HTTP2 without the need to rewrite your code.<br>
I recommend adapting to the [`http2`](https://nodejs.org/api/http2.html) module if possible - it's much simpler to use and has many cool features!

**Tip**: `http2-wrapper` is very useful when you rely on other modules that use the HTTP1 API and you want to support HTTP2.

## Installation

> `$ npm install http2-wrapper`<br>
> `$ yarn add http2-wrapper`

## Usage
```js
'use strict';
const http2 = require('http2-wrapper');

const options = {
	hostname: 'nghttp2.org',
	protocol: 'https:',
	path: '/httpbin/post',
	method: 'POST',
	headers: {
		'content-length': 6
	}
};

const request = http2.request(options, response => {
	console.log('statusCode:', response.statusCode);
	console.log('headers:', response.headers);

	const body = [];
	response.on('data', chunk => {
		body.push(chunk);
	});
	response.on('end', () => {
		console.log('body:', Buffer.concat(body).toString());
	});
});

request.on('error', e => console.error(e));

request.write('123');
request.end('456');

// statusCode: 200
// headers: { ':status': 200,
//   date: 'Sat, 11 Aug 2018 09:37:41 GMT',
//   'content-type': 'application/json',
//   'content-length': '264',
//   'access-control-allow-origin': '*',
//   'access-control-allow-credentials': 'true',
//   'x-backend-header-rtt': '0.002997',
//   'strict-transport-security': 'max-age=31536000',
//   server: 'nghttpx',
//   via: '1.1 nghttpx',
//   'x-frame-options': 'SAMEORIGIN',
//   'x-xss-protection': '1; mode=block',
//   'x-content-type-options': 'nosniff' }
// body: {
//   "args": {},
//   "data": "123456",
//   "files": {},
//   "form": {},
//   "headers": {
//     "Content-Length": "6",
//     "Host": "nghttp2.org:443",
//     "Via": "2 nghttpx"
//   },
//   "json": 123456,
//   "origin": "xxx.xxx.xxx.xxx",
//   "url": "https://nghttp2.org:443/httpbin/post"
// }
```

## API

**Note:** the `session` option accepts an instance of [`Http2Session`](https://nodejs.org/api/http2.html#http2_class_http2session). To pass a TLS session, use `tlsSession` instead.

### http2.auto(url, options, callback)

Performs [ALPN](https://nodejs.org/api/tls.html#tls_alpn_and_sni) negotiation.
Returns a Promise giving proper `ClientRequest` instance (depending on the ALPN).

**Tip**: the `agent` option also accepts an object with `http`, `https` and `http2` properties.

```js
'use strict';
const http2 = require('http2-wrapper');

const options = {
	hostname: 'httpbin.org',
	protocol: 'http:', // Note the `http:` protocol here
	path: '/post',
	method: 'POST',
	headers: {
		'content-length': 6
	}
};

(async () => {
	try {
		const request = await http2.auto(options, response => {
			console.log('statusCode:', response.statusCode);
			console.log('headers:', response.headers);

			const body = [];
			response.on('data', chunk => body.push(chunk));
			response.on('end', () => {
				console.log('body:', Buffer.concat(body).toString());
			});
		});

		request.on('error', console.error);

		request.write('123');
		request.end('456');
	} catch (error) {
		console.error(error);
	}
})();

// statusCode: 200
// headers: { connection: 'close',
//   server: 'gunicorn/19.9.0',
//   date: 'Sat, 15 Dec 2018 18:19:32 GMT',
//   'content-type': 'application/json',
//   'content-length': '259',
//   'access-control-allow-origin': '*',
//   'access-control-allow-credentials': 'true',
//   via: '1.1 vegur' }
// body: {
//   "args": {},
//   "data": "123456",
//   "files": {},
//   "form": {},
//   "headers": {
//     "Connection": "close",
//     "Content-Length": "6",
//     "Host": "httpbin.org"
//   },
//   "json": 123456,
//   "origin": "xxx.xxx.xxx.xxx",
//   "url": "http://httpbin.org/post"
// }
```

### http2.auto.prepareRequest(options)

Performs [ALPN](https://nodejs.org/api/tls.html#tls_alpn_and_sni) negotiation.
Returns a Promise giving proper request function depending on the ALPN protocol.

**Note:** the request function takes only two arguments: `options` and `callback`.

**Tip:** the `agent` option also accepts an object with `http`, `https` and `http2` properties.

### http2.auto.resolveALPN(options)

Resolves ALPN using HTTP options.

### http2.auto.protocolCache

An instance of [`quick-lru`](https://github.com/sindresorhus/quick-lru) used for caching ALPN.

There is a maximum of 100 entries. You can modify the limit through `protocolCache.maxSize` - note that the change will be visible globally.

### http2.request(url, options, callback)

Same as [`https.request`](https://nodejs.org/api/https.html#https_https_request_options_callback).

### http2.get(url, options, callback)

Same as [`https.get`](https://nodejs.org/api/https.html#https_https_get_options_callback).

### new http2.ClientRequest(url, options, callback)

Same as [`https.ClientRequest`](https://nodejs.org/api/https.html#https_class_https_clientrequest).

### new http2.IncomingMessage(socket)

Same as [`https.IncomingMessage`](https://nodejs.org/api/https.html#https_class_https_incomingmessage).

### new http2.Agent(options)

**Note:** this is **not** compatible with the classic `http.Agent`.

Usage example:

```js
'use strict';
const http2 = require('http2-wrapper');

class MyAgent extends http2.Agent {
	createConnection(authority, options) {
		console.log(`Connecting to ${authority}`);
		return http2.Agent.connect(authority, options);
	}
}

http2.get({
	hostname: 'google.com',
	agent: new MyAgent()
}, res => {
	res.on('data', chunk => console.log(`Received chunk of ${chunk.length} bytes`));
});
```

#### options

Each option is assigned to each `Agent` instance and can be changed later.

##### timeout

Type: `number`<br>
Default: `60000`

If there's no activity in given time (milliseconds), the session is closed.

##### maxSessions

Type: `number`<br>
Default: `Infinity`

Max sessions per origin.

##### maxFreeSessions

Type: `number`<br>
Default: `1`

Max free sessions per origin.

#### agent.getName(authority, options)

Returns a `string` containing a proper name for sessions created with these options.

#### agent.getSession(authority, options)

Returns a Promise giving free `Http2Session`. If no free sessions are found, a new one is created.

##### authority

Type: `string` `URL` `Object`

Authority used to create a new session.

##### options

Type: `Object`

Options used to create a new session.

#### agent.request(authority, options, headers)

Returns a Promise giving `Http2Stream`.

#### agent.createConnection(authority, options)

Returns a new `TLSSocket`. It defaults to `Agent.connect(authority, options)`.

#### agent.closeFreeSessions()

Makes an attempt to close free sessions. Only sessions with no concurrent streams are closed.

#### agent.destroy(reason)

Destroys **all** sessions.

## Notes

 - [WebSockets over HTTP2 is not supported yet](https://github.com/nodejs/node/issues/15230), although there is [a proposal](https://tools.ietf.org/html/rfc8441) already.
 - [HTTP2 sockets cannot be malformed](https://github.com/nodejs/node/blob/cc8250fab86486632fdeb63892be735d7628cd13/lib/internal/http2/core.js#L725), therefore modifying the socket will have no effect.
 - HTTP2 is a binary protocol. Headers are sent without any validation.

## Benchmarks

CPU: Intel i7-7700k<br>
Server: H2O 2.2.5 [`h2o.conf`](h2o.conf)<br>
Node: v12.6.0

```
http2-wrapper x 11,886 ops/sec ±1.90% (84 runs sampled)
http2-wrapper - preconfigured session x 14,815 ops/sec ±1.58% (87 runs sampled)
http2 x 18,272 ops/sec ±1.76% (80 runs sampled)
http2 - using PassThrough proxies x 15,215 ops/sec ±2.18% (85 runs sampled)
https x 1,613 ops/sec ±4.56% (75 runs sampled)
http x 6,676 ops/sec ±5.17% (78 runs sampled)
Fastest is http2
```

`http2-wrapper`:

- It's `1.537x` slower than `http2`.
- It's `1.280x` slower than `http2` with `PassThrough`.
- It's `7.369x` faster than `https`.
- It's `1.780x` faster than `http`.

`http2-wrapper - preconfigured session`:

- It's `1.233x` slower than `http2`.
- It's `1.027x` slower than `http2` with `PassThrough`.
- It's `9.185x` faster than `https`.
- It's `2.219x` faster than `http`.

## Related

 - [`got`](https://github.com/sindresorhus/got) - Simplified HTTP requests

## License

MIT
