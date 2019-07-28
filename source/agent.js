'use strict';
const {URL} = require('url');
const EventEmitter = require('events');
const tls = require('tls');
const http2 = require('http2');

const kCurrentStreamsCount = Symbol('currentStreamsCount');
const kRequest = Symbol('request');

const nameKeys = [
	// `http2.connect()` options
	'maxDeflateDynamicTableSize',
	'maxSessionMemory',
	'maxHeaderListPairs',
	'maxOutstandingPings',
	'maxReservedRemoteStreams',
	'maxSendHeaderBlockLength',
	'paddingStrategy',
	'peerMaxConcurrentStreams',
	'settings',

	// `tls.connect()` options
	'localAddress',
	'family',
	'path',
	'rejectUnauthorized',
	'minDHSize',

	// `tls.createSecureContext()` options
	'ca',
	'cert',
	'clientCertEngine',
	'ciphers',
	'key',
	'pfx',
	'servername',
	'minVersion',
	'maxVersion',
	'secureProtocol',
	'crl',
	'honorCipherOrder',
	'ecdhCurve',
	'dhparam',
	'secureOptions',
	'sessionIdContext'
];

const removeSession = (where, name, session) => {
	if (Reflect.has(where, name)) {
		const index = where[name].indexOf(session);

		if (index !== -1) {
			where[name].splice(index, 1);

			if (where[name].length === 0) {
				delete where[name];
			}

			return true;
		}
	}

	return false;
};

class Agent extends EventEmitter {
	constructor({timeout = 60000, maxSessions = Infinity, maxFreeSessions = 1} = {}) {
		super();

		this.busySessions = {};
		this.freeSessions = {};
		this.queue = {};

		this.timeout = timeout;
		this.maxSessions = maxSessions;
		this.maxFreeSessions = maxFreeSessions;
	}

	getName(authority, options = {}) {
		if (typeof authority === 'string') {
			authority = new URL(authority);
		}

		const port = authority.port || 443;
		const host = authority.hostname || authority.host || 'localhost';

		let name = `${host}:${port}`;

		// TODO: this should ignore defaults too
		for (const key of nameKeys) {
			if (Reflect.has(options, key)) {
				if (typeof options[key] === 'object') {
					name += `:${JSON.stringify(options[key])}`;
				} else {
					name += `:${options[key]}`;
				}
			}
		}

		return name;
	}

	_processQueue(name) {
		const busyLength = Reflect.has(this.busySessions, name) ? this.busySessions[name].length : 0;

		if (busyLength < this.maxSessions && Reflect.has(this.queue, name) && !this.queue[name].completed) {
			this.queue[name].completed = true;

			this.queue[name]();
		}
	}

	async getSession(authority, options, name) {
		return new Promise((resolve, reject) => {
			const detached = {resolve, reject};

			name = name || this.getName(authority, options);

			if (Reflect.has(this.freeSessions, name)) {
				resolve(this.freeSessions[name][0]);

				return;
			}

			if (Reflect.has(this.queue, name)) {
				this.queue[name].listeners.push(detached);

				return;
			}

			const listeners = [detached];

			const removeFromQueue = () => {
				// Our entry can be replaced. We cannot remove the new one.
				if (this.queue[name] === entry) {
					delete this.queue[name];
				}
			};

			const entry = () => {
				try {
					let receivedSettings = false;

					const session = http2.connect(authority, {
						createConnection: this.createConnection,
						...options
					});
					session[kCurrentStreamsCount] = 0;

					session.setTimeout(this.timeout, () => {
						// `.close()` would wait until all streams all closed
						session.destroy();
					});

					session.once('error', error => {
						session.destroy();

						for (const listener of listeners) {
							listener.reject(error);
						}
					});

					session.once('close', () => {
						if (!receivedSettings) {
							for (const listener of listeners) {
								listener.reject(new Error('Session closed without receiving a SETTINGS frame'));
							}
						}

						removeFromQueue();

						removeSession(this.freeSessions, name, session);
						this._processQueue(name);
					});

					session.once('remoteSettings', () => {
						removeFromQueue();

						const movedListeners = listeners.splice(session.remoteSettings.maxConcurrentStreams);

						if (movedListeners.length !== 0) {
							while (Reflect.has(this.freeSessions, name) && movedListeners.length !== 0) {
								movedListeners.shift().resolve(this.freeSessions[name][0]);
							}

							if (movedListeners.length !== 0) {
								this.getSession(authority, options, name);

								// Replace listeners with the new ones
								this.queue[name].listeners.length = 0;
								this.queue[name].listeners.push(...movedListeners);
							}
						}

						if (Reflect.has(this.freeSessions, name)) {
							this.freeSessions[name].push(session);
						} else {
							this.freeSessions[name] = [session];
						}

						for (const listener of listeners) {
							listener.resolve(session);
						}

						receivedSettings = true;
					});

					session[kRequest] = session.request;
					session.request = headers => {
						const stream = session[kRequest](headers, {
							endStream: false
						});

						session.ref();

						if (++session[kCurrentStreamsCount] >= session.remoteSettings.maxConcurrentStreams) {
							removeSession(this.freeSessions, name, session);

							if (Reflect.has(this.busySessions, name)) {
								this.busySessions[name].push(session);
							} else {
								this.busySessions[name] = [session];
							}
						}

						stream.once('close', () => {
							if (--session[kCurrentStreamsCount] < session.remoteSettings.maxConcurrentStreams) {
								if (session[kCurrentStreamsCount] === 0) {
									session.unref();
								}

								if (removeSession(this.busySessions, name, session) && !session.destroyed) {
									if ((this.freeSessions[name] || []).length < this.maxFreeSessions) {
										if (Reflect.has(this.freeSessions, name)) {
											this.freeSessions[name].push(session);
										} else {
											this.freeSessions[name] = [session];
										}
									} else {
										session.close();
									}
								}
							}
						});

						return stream;
					};
				} catch (error) {
					for (const listener of listeners) {
						listener.reject(error);
					}

					delete this.queue[name];
				}
			};

			entry.listeners = listeners;
			entry.completed = false;

			this.queue[name] = entry;
			this._processQueue(name);
		});
	}

	async request(authority, options, headers) {
		const session = await this.getSession(authority, options);
		const stream = session.request(headers);

		return stream;
	}

	createConnection(authority, options) {
		return Agent.connect(authority, options);
	}

	static connect(authority, options) {
		options.ALPNProtocols = ['h2'];

		if (typeof options.servername === 'undefined') {
			options.servername = authority.host;
		}

		const port = authority.port || 443;
		const host = authority.hostname || authority.host;

		return tls.connect(port, host, options);
	}

	closeFreeSessions() {
		for (const freeSessions of Object.values(this.freeSessions)) {
			for (const session of freeSessions) {
				if (session[kCurrentStreamsCount] === 0) {
					session.close();
				}
			}
		}
	}

	destroy(reason) {
		for (const busySessions of Object.values(this.busySessions)) {
			for (const session of busySessions) {
				session.destroy(reason);
			}
		}

		for (const freeSessions of Object.values(this.freeSessions)) {
			for (const session of freeSessions) {
				session.destroy(reason);
			}
		}
	}
}

module.exports = {
	Agent,
	globalAgent: new Agent()
};
