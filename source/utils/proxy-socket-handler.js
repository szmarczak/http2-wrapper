'use strict';
const {ERR_HTTP2_NO_SOCKET_MANIPULATION} = require('./errors');

/* istanbul ignore file */
/* https://github.com/nodejs/node/blob/5461794b12ca3f907a03396f56d5c0e070cca0b1/lib/internal/http2/compat.js#L190-L260 */

const proxySocketHandler = {
	get(stream, prop) {
		switch (prop) {
			case 'on':
			case 'once':
			case 'end':
			case 'emit':
			case 'destroy':
			case 'setTimeout':
			case 'writable':
			case 'destroyed':
			case 'readable': {
				const value = stream[prop];
				return typeof value === 'function' ? stream[prop].bind(stream) : value;
			}

			case 'write':
			case 'read':
			case 'pause':
			case 'resume':
				throw new ERR_HTTP2_NO_SOCKET_MANIPULATION();
			default: {
				const ref = stream.session === undefined ? stream : stream.session.socket;
				const value = ref[prop];
				return typeof value === 'function' ? value.bind(ref) : value;
			}
		}
	},
	getPrototypeOf(stream) {
		if (stream.session !== undefined) {
			return Reflect.getPrototypeOf(stream.session.socket);
		}

		return Reflect.getPrototypeOf(stream);
	},
	set(stream, prop, value) {
		switch (prop) {
			case 'writable':
			case 'readable':
			case 'destroyed':
			case 'on':
			case 'once':
			case 'end':
			case 'emit':
			case 'destroy':
			case 'setTimeout':
				// Node.js mistakenly checks for `stream.session` for `setTimeout`
				stream[prop] = value;
				return true;
			case 'write':
			case 'read':
			case 'pause':
			case 'resume':
				throw new ERR_HTTP2_NO_SOCKET_MANIPULATION();
			default: {
				const ref = stream.session === undefined ? stream : stream.session.socket;
				ref[prop] = value;
				return true;
			}
		}
	}
};

module.exports = proxySocketHandler;
