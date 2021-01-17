'use strict';
// See https://github.com/facebook/jest/issues/2549
// eslint-disable-next-line node/prefer-global/url
const {URL} = require('url');
const {Agent} = require('../agent');
const JSStreamSocket = require('../utils/js-stream-socket');
const UnexpectedStatusCodeError = require('./unexpected-status-code-error');
const initialize = require('./initialize');

class Http2OverHttpX extends Agent {
	constructor(options) {
		super(options);

		initialize(this, options.proxyOptions);
	}

	async getSession(origin, options = {}, listeners = []) {
		try {
			if (!(origin instanceof URL)) {
				origin = new URL(origin);
			}

			const authority = `${origin.hostname}:${origin.port || 443}`;

			const [stream, statusCode] = await this._getProxyStream(authority);
			if (statusCode !== 200) {
				throw new UnexpectedStatusCodeError(statusCode);
			}

			if (this.proxyOptions.raw) {
				options.socket = stream;
			} else {
				options.createConnection = () => {
					const socket = new JSStreamSocket(stream);
					socket.encrypted = true;
					socket.alpnProtocol = 'h2';
					socket.servername = origin.hostname;
					socket._handle.getpeername = out => {
						out.family = undefined;
						out.address = undefined;
						out.port = origin.port || undefined;
					};

					return socket;
				};
			}

			return super.getSession(origin, options, listeners);
		} catch (error) {
			if (listeners.length === 0) {
				throw error;
			}

			for (const {reject} of listeners) {
				reject(error);
			}
		}
	}
}

module.exports = Http2OverHttpX;
