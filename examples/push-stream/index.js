'use strict';
const {PassThrough} = require('stream');
const ManyKeysMap = require('many-keys-map');
const {extend: gotExtend} = require('got');
const http2 = require('../../source/index.js'); // Note: using the local version

class PushAgent extends http2.Agent {
	constructor(options) {
		super(options);
		this.settings.enablePush = true;

		this.on('session', session => {
			const pushCache = new ManyKeysMap();
			session.pushCache = pushCache;

			session.on('stream', (stream, requestHeaders) => {
				const proxy = new PassThrough({highWaterMark: 1024 * 1024}); // 1MB

				proxy.session = {
					socket: stream.session.socket
				};

				// Hacky override to avoid implementing a Duplex stream
				const end = proxy.end.bind(proxy);
				proxy.end = (...args) => {
					end(...args);

					// Node 13 throws when double-ending
					proxy.end = () => {};
				};

				stream.pipe(proxy);

				const parsedPushHeaders = PushAgent._parsePushHeaders(undefined, requestHeaders);

				if (pushCache.has(parsedPushHeaders)) {
					stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
					return;
				}

				stream.once('push', pushHeaders => {
					pushCache.set(parsedPushHeaders, {stream: proxy, pushHeaders});
				});
			});
		});
	}

	request(origin, sessionOptions, headers, streamOptions) {
		return new Promise((resolve, reject) => {
			// The code after `await agent.getSession()` isn't executed immediately after calling `resolve()`,
			// so we need to use semi-callback style to support the `maxFreeSessions` option mechanism.

			// For further information please see the source code of the `processListeners` function (`source/agent.js` file).
			// A solution to avoid this hack will be greatly appreciated!

			this.getSession(origin, sessionOptions, [{
				reject,
				resolve: session => {
					const normalizedAuthority = (new URL(origin)).origin;

					const parsedPushHeaders = PushAgent._parsePushHeaders(normalizedAuthority, headers);
					const cache = session.pushCache.get(parsedPushHeaders);
					if (cache) {
						const {stream, pushHeaders} = cache;
						session.pushCache.delete(parsedPushHeaders);

						setImmediate(() => {
							stream.emit('response', pushHeaders);
						});

						resolve(stream);
						return;
					}

					resolve(session.request(headers, streamOptions));
				}
			}]);
		});
	}

	static _parsePushHeaders(authority, headers) {
		return [
			headers[':authority'] || authority,
			headers[':path'] || '/',
			headers[':method'] || 'GET'
		];
	}
}

(async () => {
	const agent = new PushAgent();

	const got = gotExtend({
		prefixUrl: 'https://localhost:3000',
		request: http2.auto,
		http2: true,
		rejectUnauthorized: false,
		agent: {
			http2: agent
		}
	});

	const response = await got('');
	console.log('/', response.body, response.headers);

	const pushResponse = await got('push');
	console.log('/push', pushResponse.body, pushResponse.headers);
})();
