'use strict';
const {Agent} = require('../agent');

class ClassicProxyAgent extends Agent {
	constructor({url, proxyOptions = {}, agentOptions}) {
		super(agentOptions);

		this.origin = new URL(url);
		this.proxyOptions = {...proxyOptions, headers: {...proxyOptions.headers}};

		const {username, password} = this.origin;
		if (username || password) {
			const data = `${username}:${password}`;
			this.proxyOptions.headers['proxy-authorization'] = `Basic ${Buffer.from(data).toString('base64')}`;
		}
	}

	request(origin, sessionOptions, headers, streamOptions) {
		if (!(origin instanceof URL)) {
			origin = new URL(origin);
		}

		headers = {...headers};

		if (this.proxyOptions.overrideAuthorityHeader === false) {
			delete headers[':authority'];
			headers[':path'] = `/${origin.origin}${headers[':path'] || ''}`;
		}

		return super.request(this.origin, {
			...sessionOptions,
			...this.proxyOptions
		}, {
			...headers,
			...this.proxyOptions.headers
		}, streamOptions);
	}
}

module.exports = ClassicProxyAgent;
