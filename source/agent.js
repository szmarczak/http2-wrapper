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

	// `tls.connect()` options
	'localAddress',
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

class Agent extends EventEmitter {
	constructor({timeout = 60000, maxSessions = Infinity, maxFreeSessions = 1} = {}) {
		super();

		this.busySessions = {};
		this.freeSessions = {};
		this.queue = {};

		this.timeout = timeout;
		this.maxSessions = maxSessions;
		this.maxFreeSessions = maxFreeSessions;

		this.settings = {
			enablePush: false
		};
	}

	getName(authority, options) {
		if (typeof authority === 'string') {
			authority = new URL(authority);
		}

		const port = authority.port || 443;
		const host = authority.hostname || authority.host || 'localhost';

		let name = `${host}:${port}`;

		if (options) {
			for (const key of nameKeys) {
				if (Reflect.has(options, key)) {
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

	async getSession(authority, options) {
		return new Promise((resolve, reject) => {
			const name = this.getName(authority, options);
			const detached = {resolve, reject};

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
						settings: this.settings,
						...options
					});
					session[kCurrentStreamsCount] = 0;

					const getParent = () => {
						if (session[kCurrentStreamsCount] === session.remoteSettings.maxConcurrentStreams) {
							return this.busySessions;
						}

						return this.freeSessions;
					};

					let previousOrigins = [];
					let previousParent = this.freeSessions;
					const removeOrigins = () => {
						const parent = getParent();

						for (const origin of previousOrigins) {
							const name = this.getName(origin, options);
							const sessions = parent[name];

							if (sessions && sessions.length > 1) {
								sessions.splice(sessions.indexOf(session), 1);
							} else {
								delete parent[name];
							}

							this._processQueue(name);
						}

						previousOrigins = [];
					};

					const updateOrigins = () => {
						const parent = getParent();

						if (parent === previousParent && !session.destroyed) {
							return;
						}

						removeOrigins();

						if (session.destroyed) {
							return;
						}

						if (parent === this.freeSessions && (this.freeSessions[name] || []).length >= this.maxFreeSessions) {
							return false;
						}

						for (const origin of session.originSet) {
							const name = this.getName(origin, options);
							const sessions = parent[name];

							if (sessions) {
								sessions.push(session);
							} else {
								parent[name] = [session];
							}
						}

						previousOrigins = session.originSet;
						previousParent = parent;

						return true;
					};

					const handleOverload = () => {
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
					};

					session.setTimeout(this.timeout, () => {
						// `session.close()` would wait until all streams all closed
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
						removeOrigins();
					});

					session.on('origin', () => {
						updateOrigins();

						// TODO: close sessions which originSet is full covered by this session
					});

					session.once('localSettings', () => {
						removeFromQueue();
						handleOverload();
						updateOrigins();

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
						session[kCurrentStreamsCount]++;

						updateOrigins();

						stream.once('close', () => {
							session[kCurrentStreamsCount]--;

							console.log('CLOSING', session[kCurrentStreamsCount]);
							if (updateOrigins() === false) {
								session.close();
							} else if (session[kCurrentStreamsCount] === 0) {
								session.unref();
							}
						});

						return stream;
					};

					this.emit('session', session);
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

		return session.request(headers);
	}

	createConnection(authority, options) {
		return Agent.connect(authority, options);
	}

	static connect(authority, options) {
		options.ALPNProtocols = ['h2'];

		const port = authority.port || 443;
		const host = authority.hostname || authority.host;

		if (typeof options.servername === 'undefined') {
			options.servername = host;
		}

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
