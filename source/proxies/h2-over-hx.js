'use strict';
const {Agent} = require('../agent');
const JSStreamSocket = require('../utils/js-stream-socket');
const UnexpectedStatusCodeError = require('./unexpected-status-code-error');
const initialize = require('./initialize');

class Http2OverHttpX extends Agent {
	constructor(options) {
		super(options);

		initialize(this, options.proxyOptions);
	}

	async createConnection(origin, options) {
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

		return super.createConnection(origin, options);
	}
}

module.exports = Http2OverHttpX;
