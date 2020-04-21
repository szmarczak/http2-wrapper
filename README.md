# http2-wrapper
> HTTP2 client, just with the familiar `https` API

[![Node CI](https://github.com/szmarczak/http2-wrapper/workflows/Node%20CI/badge.svg)](https://github.com/szmarczak/http2-wrapper/actions)
[![Coverage Status](https://coveralls.io/repos/github/szmarczak/http2-wrapper/badge.svg?branch=master)](https://coveralls.io/github/szmarczak/http2-wrapper?branch=master)
[![npm](https://img.shields.io/npm/dm/http2-wrapper.svg)](https://www.npmjs.com/package/http2-wrapper)
[![install size](https://packagephobia.now.sh/badge?p=http2-wrapper)](https://packagephobia.now.sh/result?p=http2-wrapper)

This package was created to support HTTP2 without the need to rewrite your code.<br>
I recommend adapting to the [`http2`](https://nodejs.org/api/http2.html) module if possible - it's much simpler to use and has many cool features!

**Tip**: `http2-wrapper` is very useful when you rely on other modules that use the HTTP1 API and you want to support HTTP2.

**Pro Tip**: While the native `http2` doesn't have agents yet, you can use `http2-wrapper` Agents and still operate on the native HTTP2 streams.

## Installation

> `$ npm install http2-wrapper`<br>
> `$ yarn add http2-wrapper`

## Usage
```js
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
// headers: [Object: null prototype] {
//   ':status': 200,
//   date: 'Fri, 27 Sep 2019 19:45:46 GMT',
//   'content-type': 'application/json',
//   'access-control-allow-origin': '*',
//   'access-control-allow-credentials': 'true',
//   'content-length': '239',
//   'x-backend-header-rtt': '0.002516',
//   'strict-transport-security': 'max-age=31536000',
//   server: 'nghttpx',
//   via: '1.1 nghttpx',
//   'alt-svc': 'h3-23=":4433"; ma=3600',
//   'x-frame-options': 'SAMEORIGIN',
//   'x-xss-protection': '1; mode=block',
//   'x-content-type-options': 'nosniff'
// }
// body: {
//   "args": {},
//   "data": "123456",
//   "files": {},
//   "form": {},
//   "headers": {
//     "Content-Length": "6",
//     "Host": "nghttp2.org"
//   },
//   "json": 123456,
//   "origin": "xxx.xxx.xxx.xxx",
//   "url": "https://nghttp2.org/httpbin/post"
// }
```

## API

**Note:** The `session` option was renamed to `tlsSession` for better readability.

### http2.auto(url, options, callback)

Performs [ALPN](https://nodejs.org/api/tls.html#tls_alpn_and_sni) negotiation.
Returns a Promise giving proper `ClientRequest` instance (depending on the ALPN).

**Note**: The `agent` option represents an object with `http`, `https` and `http2` properties.

```js
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

### http2.auto.protocolCache

An instance of [`quick-lru`](https://github.com/sindresorhus/quick-lru) used for ALPN cache.

There is a maximum of 100 entries. You can modify the limit through `protocolCache.maxSize` - note that the change will be visible globally.

### http2.request(url, options, callback)

Same as [`https.request`](https://nodejs.org/api/https.html#https_https_request_options_callback).

##### options.h2session

Type: `Http2Session`<br>

The session used to make the actual request. If none provided, it will use `options.agent`.

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
const http2 = require('http2-wrapper');

class MyAgent extends http2.Agent {
	createConnection(origin, options) {
		console.log(`Connecting to ${http2.Agent.normalizeOrigin(origin)}`);
		return http2.Agent.connect(origin, options);
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

If there's no activity after `timeout` milliseconds, the session will be closed.

##### maxSessions

Type: `number`<br>
Default: `Infinity`

The maximum amount of sessions per origin.

##### maxFreeSessions

Type: `number`<br>
Default: `1`

The maximum amount of free sessions per origin.

##### maxCachedTlsSessions

Type: `number`<br>
Default: `100`

The maximum amount of cached TLS sessions.

#### Agent.normalizeOrigin(url)

Returns a string representing the origin of the URL.

#### agent.settings

Type: `object`<br>
Default: `{enablePush: false}`

[Settings](https://nodejs.org/api/http2.html#http2_settings_object) used by the current agent instance.

#### agent.normalizeOptions([options](https://github.com/szmarczak/http2-wrapper/blob/master/source/agent.js))

Returns a string representing normalized options.

```js
Agent.normalizeOptions({servername: 'example.com'});
// => ':example.com'
```

#### agent.getSession(origin, options)

##### [origin](https://nodejs.org/api/http2.html#http2_http2_connect_authority_options_listener)

Type: `string` `URL` `object`

An origin used to create new session.

##### [options](https://nodejs.org/api/http2.html#http2_http2_connect_authority_options_listener)

Type: `object`

The options used to create new session.

Returns a Promise giving free `Http2Session`. If no free sessions are found, a new one is created.

#### agent.getSession([origin](#origin), [options](options-1), listener)

##### listener

Type: `object`

```
{
	reject: error => void,
	resolve: session => void
}
```

If the `listener` argument is present, the Promise will resolve immediately. It will use the `resolve` function to pass the session.

#### agent.request([origin](#origin), [options](#options-1), [headers](https://nodejs.org/api/http2.html#http2_headers_object))

Returns a Promise giving `Http2Stream`.

#### agent.createConnection([origin](#origin), [options](#options-1))

Returns a new `TLSSocket`. It defaults to `Agent.connect(origin, options)`.

#### agent.closeFreeSessions()

Makes an attempt to close free sessions. Only sessions with 0 concurrent streams will be closed.

#### agent.destroy(reason)

Destroys **all** sessions.

#### Event: 'session'

```js
agent.on('session', session => {
	// A new session has been created by the Agent.
});
```

## Notes

 - If you're interested in [WebSockets over HTTP2](https://tools.ietf.org/html/rfc8441), then [check out this discussion](https://github.com/websockets/ws/issues/1458).
 - [HTTP2 sockets cannot be malformed](https://github.com/nodejs/node/blob/cc8250fab86486632fdeb63892be735d7628cd13/lib/internal/http2/core.js#L725), therefore modifying the socket will have no effect.
 - You can make [a custom Agent](examples/push-stream/index.js) to support push streams.

## Benchmarks

CPU: Intel i7-7700k (governor: performance)<br>
Server: H2O v2.2.5 [`h2o.conf`](h2o.conf)<br>
Node: v13.8.0

`auto` means `http2wrapper.auto`.

```
http2-wrapper                         x 12,417 ops/sec ±3.72% (83 runs sampled)
http2-wrapper - preconfigured session x 14,517 ops/sec ±1.39% (83 runs sampled)
http2-wrapper - auto                  x 11,373 ops/sec ±3.17% (84 runs sampled)
http2                                 x 16,172 ops/sec ±1.21% (85 runs sampled)
https         - auto - keepalive      x 13,251 ops/sec ±3.84% (79 runs sampled)
https                - keepalive      x 13,158 ops/sec ±2.88% (78 runs sampled)
https                                 x 1,618 ops/sec  ±2.07%  (82 runs sampled)
http                                  x 5,922 ops/sec  ±2.87%  (79 runs sampled)
Fastest is http2
```

`http2-wrapper`:
- 23% less performant than `http2`
- 6% less performant than `https - keepalive`
- 110% more performant than `http`

`http2-wrapper - preconfigured session`:
- 10% less performant than `http2`
- 10% more performant than `https - keepalive`
- 145% more performant than `http`

`http2-wrapper - auto`:
- 30% less performant than `http2`
- 14% less performant than `https - keepalive`
- 92% more performant than `http`

`https - auto - keepalive`:
- 18% less performant than `http2`
- as performant as `https - keepalive`
- 124% more performant than `http`

## Related

 - [`got`](https://github.com/sindresorhus/got) - Simplified HTTP requests

## License

MIT
