'use strict';
const {ERR_HTTP2_NO_SOCKET_MANIPULATION} = require('./errors');

/* istanbul ignore file */
/* https://github.com/nodejs/node/blob/6eec858f34a40ffa489c1ec54bb24da72a28c781/lib/internal/http2/compat.js#L195-L272 */

const functionPrototypeBind = Function.prototype.bind;
const reflectGetPrototypeOf = Reflect.getPrototypeOf;

const proxySocketHandler = {
	has(stream, property) {
		// Replaced [kSocket] with .socket
		const reference = stream.session === undefined ? stream : stream.session.socket;
		return (property in stream) || (property in reference);
	},

	get(stream, property) {
		switch (property) {
			case 'on':
			case 'once':
			case 'end':
			case 'emit':
			case 'destroy':
				return functionPrototypeBind(stream[property], stream);
			case 'writable':
			case 'destroyed':
				return stream[property];
			case 'readable':
				if (stream.destroyed) {
					return false;
				}

				return stream.readable;
			case 'setTimeout': {
				const {session} = stream;
				if (session !== undefined) {
					return functionPrototypeBind(session.setTimeout, session);
				}

				return functionPrototypeBind(stream.setTimeout, stream);
			}

			case 'write':
			case 'read':
			case 'pause':
			case 'resume':
				throw new ERR_HTTP2_NO_SOCKET_MANIPULATION();
			default: {
				// Replaced [kSocket] with .socket
				const reference = stream.session === undefined ? stream : stream.session.socket;
				const value = reference[property];

				return typeof value === 'function' ? functionPrototypeBind(value, reference) : value;
			}
		}
	},

	getPrototypeOf(stream) {
		if (stream.session !== undefined) {
			// Replaced [kSocket] with .socket
			return reflectGetPrototypeOf(stream.session.socket);
		}

		return reflectGetPrototypeOf(stream);
	},

	set(stream, property, value) {
		switch (property) {
			case 'writable':
			case 'readable':
			case 'destroyed':
			case 'on':
			case 'once':
			case 'end':
			case 'emit':
			case 'destroy':
				stream[property] = value;
				return true;
			case 'setTimeout': {
				const {session} = stream;
				if (session === undefined) {
					stream.setTimeout = value;
				} else {
					session.setTimeout = value;
				}

				return true;
			}

			case 'write':
			case 'read':
			case 'pause':
			case 'resume':
				throw new ERR_HTTP2_NO_SOCKET_MANIPULATION();
			default: {
				// Replaced [kSocket] with .socket
				const reference = stream.session === undefined ? stream : stream.session.socket;
				reference[property] = value;
				return true;
			}
		}
	}
};

module.exports = proxySocketHandler;
