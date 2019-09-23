'use strict';
const {URL} = require('url');
const EventEmitter = require('events');
const tls = require('tls');
const http2 = require('http2');
const QuickLRU = require('quick-lru');

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

const getSessions = (where, name, normalizedAuthority) => {
	if (Reflect.has(where, name)) {
		return where[name].filter(session => {
			return session.originSet.includes(normalizedAuthority);
		});
	}

	return [];
};

const closeCoveredSessions = (where, name, session) => {
	if (!Reflect.has(where, name)) {
		return;
	}

	for (const coveredSession of where[name]) {
		if (
			coveredSession !== session &&
			coveredSession.originSet.length < session.originSet.length &&
			coveredSession.originSet.every(origin => session.originSet.includes(origin)) &&
			coveredSession[kCurrentStreamsCount] + session[kCurrentStreamsCount] <= session.remoteSettings.maxConcurrentStreams
		) {
			coveredSession.close();
		}
	}
};

class Agent extends EventEmitter {
	constructor({timeout = 60000, maxSessions = Infinity, maxFreeSessions = 1, maxCachedTlsSessions = 100} = {}) {
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

		this.tlsSessionCache = new QuickLRU({maxSize: maxCachedTlsSessions});
	}

	normalizeAuthority(authority) {
		if (typeof authority === 'string') {
			authority = new URL(authority);
		}

		const host = authority.hostname || authority.host || 'localhost';
		const port = authority.port || 443;

		if (port === 443) {
			return `https://${host}`;
		}

		return `https://${host}:${port}`;
	}

	normalizeOptions(options) {
		let normalized = '';

		if (options) {
			for (const key of nameKeys) {
				if (Reflect.has(options, key)) {
					normalized += `:${options[key]}`;
				}
			}
		}

		return normalized;
	}

	_processQueue(normalizedOptions, normalizedAuthority) {
		if (!Reflect.has(this.queue, normalizedOptions) || !Reflect.has(this.queue[normalizedOptions], normalizedAuthority)) {
			return;
		}

		const busyLength = getSessions(this.busySessions, normalizedOptions, normalizedAuthority).length;
		const item = this.queue[normalizedOptions][normalizedAuthority];

		if (busyLength < this.maxSessions && !item.completed) {
			item.completed = true;

			item();
		}
	}

	async getSession(authority, options) {
		return new Promise((resolve, reject) => {
			const detached = {resolve, reject};
			const normalizedOptions = this.normalizeOptions(options);
			const normalizedAuthority = this.normalizeAuthority(authority);

			if (Reflect.has(this.freeSessions, normalizedOptions)) {
				const freeSessions = getSessions(this.freeSessions, normalizedOptions, normalizedAuthority);

				if (freeSessions.length !== 0) {
					resolve(freeSessions.reduce((previousValue, nextValue) => {
						if (nextValue[kCurrentStreamsCount] > previousValue[kCurrentStreamsCount]) {
							return nextValue;
						}

						return previousValue;
					}));

					return;
				}
			}

			if (Reflect.has(this.queue, normalizedOptions)) {
				if (Reflect.has(this.queue[normalizedOptions], normalizedAuthority)) {
					this.queue[normalizedOptions][normalizedAuthority].listeners.push(detached);

					return;
				}
			} else {
				this.queue[normalizedOptions] = {};
			}

			const listeners = [detached];

			const removeFromQueue = () => {
				// Our entry can be replaced. We cannot remove the new one.
				if (Reflect.has(this.queue, normalizedOptions) && this.queue[normalizedOptions][normalizedAuthority] === entry) {
					delete this.queue[normalizedOptions][normalizedAuthority];

					if (Object.keys(this.queue[normalizedOptions]).length === 0) {
						delete this.queue[normalizedOptions];
					}
				}
			};

			const entry = () => {
				try {
					const name = `${normalizedAuthority}:${normalizedOptions}`;
					let receivedSettings = false;
					let servername;

					const tlsSessionCache = this.tlsSessionCache.get(name);

					const session = http2.connect(authority, {
						createConnection: this.createConnection,
						settings: this.settings,
						session: tlsSessionCache ? tlsSessionCache.session : undefined,
						...options
					});
					session[kCurrentStreamsCount] = 0;

					session.socket.once('session', session => {
						this.tlsSessionCache.set(name, {
							session,
							servername
						});
					});

					// See https://github.com/nodejs/node/issues/28985
					session.socket.once('secureConnect', () => {
						servername = session.socket.servername;

						if (servername === false && typeof tlsSessionCache !== 'undefined') {
							session.socket.servername = tlsSessionCache.servername;
						}
					});

					session.once('error', error => {
						session.destroy();

						for (const listener of listeners) {
							listener.reject(error);
						}

						this.tlsSessionCache.delete(name);
					});

					session.setTimeout(this.timeout, () => {
						// `.close()` gracefully closes the session. Current streams wouldn't be terminated that way.
						session.destroy();
					});

					session.once('close', () => {
						if (!receivedSettings) {
							for (const listener of listeners) {
								listener.reject(new Error('Session closed without receiving a SETTINGS frame'));
							}
						}

						removeFromQueue();
						removeSession(this.freeSessions, normalizedOptions, session);

						// TODO: this needs tests (session `close` event emitted before its streams were closed)
						// See https://travis-ci.org/szmarczak/http2-wrapper/jobs/587629103#L282
						removeSession(this.busySessions, normalizedOptions, session);

						this._processQueue(normalizedOptions, normalizedAuthority);
					});

					// The Origin Set cannot shrink.
					session.once('origin', () => {
						if (session[kCurrentStreamsCount] >= session.remoteSettings.maxConcurrentStreams) {
							return;
						}

						closeCoveredSessions(this.freeSessions, normalizedOptions, session);
						closeCoveredSessions(this.busySessions, normalizedOptions, session);

						for (const authority in this.queue[normalizedOptions]) {
							if (session.originSet.includes(authority)) {
								const {listeners} = this.queue[normalizedOptions][authority];
								const movedListeners = listeners.splice(session.remoteSettings.maxConcurrentStreams - session[kCurrentStreamsCount]);

								while (movedListeners.length !== 0 && session[kCurrentStreamsCount] < session.remoteSettings.maxConcurrentStreams) {
									movedListeners.shift().resolve(session);
								}

								if (movedListeners.length === 0) {
									delete this.queue[normalizedOptions][authority];

									if (Object.keys(this.queue[normalizedOptions]).length === 0) {
										delete this.queue[normalizedOptions];
									}
								}
							}
						}
					});

					session.once('localSettings', () => {
						removeFromQueue();

						const movedListeners = listeners.splice(session.remoteSettings.maxConcurrentStreams);

						if (movedListeners.length !== 0) {
							const freeSessions = getSessions(this.freeSessions, normalizedOptions, normalizedAuthority);

							while (freeSessions.length !== 0 && movedListeners.length !== 0) {
								movedListeners.shift().resolve(freeSessions[0]);

								if (freeSessions[0][kCurrentStreamsCount] >= freeSessions[0].remoteSettings.maxConcurrentStreams) {
									freeSessions.shift();
								}
							}

							if (movedListeners.length !== 0) {
								this.getSession(authority, options);

								// Replace listeners with the new ones
								const {listeners} = this.queue[normalizedOptions][normalizedAuthority];
								listeners.length = 0;
								listeners.push(...movedListeners);
							}
						}

						if (Reflect.has(this.freeSessions, normalizedOptions)) {
							this.freeSessions[normalizedOptions].push(session);
						} else {
							this.freeSessions[normalizedOptions] = [session];
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
							removeSession(this.freeSessions, normalizedOptions, session);

							if (Reflect.has(this.busySessions, normalizedOptions)) {
								this.busySessions[normalizedOptions].push(session);
							} else {
								this.busySessions[normalizedOptions] = [session];
							}
						}

						stream.once('close', () => {
							if (--session[kCurrentStreamsCount] < session.remoteSettings.maxConcurrentStreams) {
								if (session[kCurrentStreamsCount] === 0) {
									session.unref();
								}

								if (removeSession(this.busySessions, normalizedOptions, session) && !session.destroyed && !session.closed) {
									const freeSessionsLength = getSessions(this.freeSessions, normalizedOptions, normalizedAuthority).length;

									if (freeSessionsLength < this.maxFreeSessions) {
										if (Reflect.has(this.freeSessions, normalizedOptions)) {
											this.freeSessions[normalizedOptions].push(session);
										} else {
											this.freeSessions[normalizedOptions] = [session];
										}

										// The session cannot be uncovered at this point. To be uncovered,
										// the only possible way is to make another session cover this one.

										closeCoveredSessions(this.freeSessions, normalizedOptions, session);
										closeCoveredSessions(this.busySessions, normalizedOptions, session);
									} else {
										session.close();
									}
								}
							}
						});

						return stream;
					};

					this.emit('session', session);
				} catch (error) {
					for (const listener of listeners) {
						listener.reject(error);
					}

					delete this.queue[normalizedOptions][normalizedAuthority];
				}
			};

			entry.listeners = listeners;
			entry.completed = false;

			this.queue[normalizedOptions][normalizedAuthority] = entry;
			this._processQueue(normalizedOptions, normalizedAuthority);
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
