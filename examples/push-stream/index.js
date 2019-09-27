'use strict';
const ManyKeysMap = require('many-keys-map');
const {extend: gotExtend} = require('got');
const http2 = require('../../source'); // Note: using the local version

class PushAgent extends http2.Agent {
	constructor(options) {
		super(options);
		this.settings.enablePush = true;

		this.on('session', session => {
			const pushCache = new ManyKeysMap();
			session.pushCache = pushCache;

			session.on('stream', (stream, requestHeaders) => {
				const parsedPushHeaders = PushAgent._parsePushHeaders(requestHeaders);

				if (pushCache.has(parsedPushHeaders)) {
					stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
					return;
				}

				stream.once('push', pushHeaders => {
					pushCache.set(parsedPushHeaders, {stream, pushHeaders});
				});
			});
		});
	}

	request(authority, options, headers) {
		return new Promise((resolve, reject) => {
			// We need to use semi-callback style to support the `maxFreeSessions` option mechanism.
			// The code after `await agent.request()` isn't executed immediately after calling `resolve()`.

			this.getSession(authority, options, [{
				reject,
				resolve: session => {
					const parsedPushHeaders = PushAgent._parsePushHeaders(headers);
					const cache = session.pushCache.get(parsedPushHeaders);
					if (cache) {
						const {stream, pushHeaders} = cache;
						delete session.pushCache.delete(parsedPushHeaders);

						setImmediate(() => {
							stream.emit('response', pushHeaders);
						});

						resolve(stream);
						return;
					}

					resolve(session.request(headers));
				}
			}]);
		});
	}

	static _parsePushHeaders(headers) {
		// TODO: headers[':authority'] needs to be verified properly.

		return [
			headers[':path'] || '/',
			headers[':method'] || 'GET'
		];
	}
}

(async () => {
	const agent = new PushAgent();

	const got = gotExtend({
		baseUrl: 'https://localhost:3000',
		request: http2.request,
		rejectUnauthorized: false,
		agent
	});

	const response = await got('');
	console.log('/', response.body, response.headers);

	const pushResponse = await got('push');
	console.log('/push', pushResponse.body, pushResponse.headers);
})();
