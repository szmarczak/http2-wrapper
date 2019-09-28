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
				const parsedPushHeaders = PushAgent._parsePushHeaders(undefined, requestHeaders);

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
			// The code after `await agent.getSession()` isn't executed immediately after calling `resolve()`,
			// so we need to use semi-callback style to support the `maxFreeSessions` option mechanism.

			// For further information please see the source code of the `processListeners` function (`source/agent.js` file).

			this.getSession(authority, options, [{
				reject,
				resolve: session => {
					const normalizedAuthority = http2.Agent.normalizeAuthority(authority, options.servername);

					const parsedPushHeaders = PushAgent._parsePushHeaders(normalizedAuthority, headers);
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
