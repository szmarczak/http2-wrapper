'use strict';
const {Agent} = require('../agent');

class ClassicProxyAgent extends Agent {
	constructor({url, proxyOptions = {}, agentOptions}) {
		super(agentOptions);

		this.origin = new URL(url);
		this.proxyOptions = proxyOptions;

		const {username, password} = this.origin;
		if (username || password) {
			const data = `${username}:${password}`;
			this.proxyOptions.authorization = `Basic ${Buffer.from(data).toString('base64')}`;
		}
	}

	request(origin, sessionOptions, headers, streamOptions) {
		if (!(origin instanceof URL)) {
			origin = new URL(origin);
		}

		return super.request(this.origin, {
			...sessionOptions,
			...this.proxyOptions
		}, {
			...headers,
			// This will automatically force the `:authority` header to be the proxy origin server.
			// Otherwise, it would point incorrectly to the requested origin we want be proxied.
			':authority': undefined,
			':path': `/${origin.origin}${headers[':path'] || ''}`,
			'proxy-authorization': this.proxyOptions.authorization
		}, streamOptions);
	}
}

module.exports = ClassicProxyAgent;
