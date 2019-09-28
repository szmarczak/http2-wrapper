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

const addSession = (where, name, session) => {
	if (Reflect.has(where, name)) {
		where[name].push(session);
	} else {
		where[name] = [session];
	}
};

const getSessions = (where, name, normalizedAuthority) => {
	if (Reflect.has(where, name)) {
		return where[name].filter(session => {
			return !session.closed && !session.destroyed && session.originSet.includes(normalizedAuthority);
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
		this.maxFreeSessions = maxFreeSessions; // TODO: decreasing `maxFreeSessions` should close some sessions

		this.settings = {
			enablePush: false
		};

		this.tlsSessionCache = new QuickLRU({maxSize: maxCachedTlsSessions});
	}

	static normalizeAuthority(authority, servername) {
		if (typeof authority === 'string') {
			authority = new URL(authority);
		}

		const host = servername || authority.hostname || authority.host || 'localhost';
		const port = authority.port || 443;

		if (port === 443) {
			return `https://${host}`;
		}

		return `https://${host}:${port}`;
	}

	static normalizeOptions(options) {
		let normalized = '';

		if (options) {
			for (const key of nameKeys) {
				if (options[key]) {
					normalized += `:${options[key]}`;
				}
			}
		}

		return normalized;
	}

	_tryToCreateNewSession(normalizedOptions, normalizedAuthority) {
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

	getSession(authority, options, listeners) {
		return new Promise((resolve, reject) => {
			if (Array.isArray(listeners)) {
				listeners = [...listeners];

				// Resolve the current promise ASAP, because we're just moving the listeners.
				resolve();
			} else {
				listeners = [{resolve, reject}];
			}

			const normalizedOptions = Agent.normalizeOptions(options);
			const normalizedAuthority = Agent.normalizeAuthority(authority, options && options.servername);

			if (Reflect.has(this.freeSessions, normalizedOptions)) {
				const freeSessions = getSessions(this.freeSessions, normalizedOptions, normalizedAuthority);

				if (freeSessions.length !== 0) {
					for (const listener of listeners) {
						listener.resolve(freeSessions.reduce((previousSession, nextSession) => {
							if (nextSession[kCurrentStreamsCount] > previousSession[kCurrentStreamsCount]) {
								return nextSession;
							}

							return previousSession;
						}));
					}

					return;
				}
			}

			if (Reflect.has(this.queue, normalizedOptions)) {
				if (Reflect.has(this.queue[normalizedOptions], normalizedAuthority)) {
					this.queue[normalizedOptions][normalizedAuthority].listeners.push(...listeners);

					return;
				}
			} else {
				this.queue[normalizedOptions] = {};
			}

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

					const freeSession = () => {
						const freeSessionsLength = getSessions(this.freeSessions, normalizedOptions, normalizedAuthority).length;

						if (freeSessionsLength < this.maxFreeSessions) {
							addSession(this.freeSessions, normalizedOptions, session);

							this.emit('free', session);
							return true;
						}

						return false;
					};

					const isFree = () => session[kCurrentStreamsCount] < session.remoteSettings.maxConcurrentStreams;

					session.socket.once('session', tlsSession => {
						setImmediate(() => {
							this.tlsSessionCache.set(name, {
								session: tlsSession,
								servername
							});
						});
					});

					// See https://github.com/nodejs/node/issues/28985
					session.socket.once('secureConnect', () => {
						servername = session.socket.servername;

						if (servername === false && typeof tlsSessionCache !== 'undefined' && typeof tlsSessionCache.servername !== 'undefined') {
							session.socket.servername = tlsSessionCache.servername;
						}
					});

					const errorListener = error => {
						for (const listener of listeners) {
							listener.reject(error);
						}

						// The cache won't be deleted if it errored after it had connected.
						// See https://github.com/nodejs/node/issues/28966
						this.tlsSessionCache.delete(name);
					};

					session.once('error', errorListener);

					session.setTimeout(this.timeout, () => {
						// Terminates all streams owend by this session. `session.close()` would gracefully close it instead.
						session.destroy();

						this.emit('close', session);
					});

					session.once('close', () => {
						if (!receivedSettings) {
							for (const listener of listeners) {
								listener.reject(new Error('Session closed without receiving a SETTINGS frame'));
							}
						}

						removeFromQueue();
						removeSession(this.freeSessions, normalizedOptions, session);

						// This is needed. A session can be destroyed,
						// so `sessionsCount < maxSessions` and there may be callback awaiting already.
						this._tryToCreateNewSession(normalizedOptions, normalizedAuthority);
					});

					const processListeners = () => {
						if (!Reflect.has(this.queue, normalizedOptions)) {
							return;
						}

						for (const origin of session.originSet) {
							if (Reflect.has(this.queue[normalizedOptions], origin)) {
								const {listeners} = this.queue[normalizedOptions][origin];
								while (listeners.length !== 0 && isFree()) {
									// We assume `resolve(...)` calls `request(...)` *directly*,
									// otherwise the session will get overloaded.
									listeners.shift().resolve(session);
								}

								if (this.queue[normalizedOptions][origin].length === 0) {
									delete this.queue[normalizedOptions][origin];

									if (Object.keys(this.queue[normalizedOptions]).length === 0) {
										delete this.queue[normalizedOptions];
										break;
									}
								}
							}
						}

						// It isn't possible for the queue to exceed the stream limit of two free sessions.
						// The queue will start immediately if there's at least one free session.
						// The queue will be cleared. If not, it will wait for another free session.
					};

					// The Origin Set cannot shrink. No need to check if it suddenly became covered by another one.
					session.once('origin', () => {
						if (!isFree()) {
							return;
						}

						closeCoveredSessions(this.freeSessions, normalizedOptions, session);
						closeCoveredSessions(this.busySessions, normalizedOptions, session);
						processListeners();
					});

					session.once('remoteSettings', () => {
						if (entry.destroyed) {
							for (const listener of listeners) {
								listener.reject(new Error('Agent has been destroyed'));
							}

							session.destroy();
							return;
						}

						if (freeSession()) {
							processListeners();
						} else if (this.maxFreeSessions === 0) {
							processListeners();
							setImmediate(() => {
								session.close();

								this.emit('close', session);
							});
						} else {
							session.close();

							this.emit('close', session);
						}

						if (listeners.length !== 0) {
							// Requests for a new session with predefined listeners
							this.getSession(normalizedAuthority, options, listeners);
							listeners.length = 0;
						}

						session.removeListener('error', errorListener);

						receivedSettings = true;
						removeFromQueue();
					});

					session[kRequest] = session.request;
					session.request = headers => {
						const stream = session[kRequest](headers, {
							endStream: false
						});

						session.ref();

						++session[kCurrentStreamsCount];

						if (!isFree() && removeSession(this.freeSessions, normalizedOptions, session)) {
							addSession(this.busySessions, normalizedOptions, session);

							this.emit('busy', session);
						}

						stream.once('close', () => {
							--session[kCurrentStreamsCount];

							if (isFree()) {
								if (session[kCurrentStreamsCount] === 0) {
									session.unref();
								}

								if (removeSession(this.busySessions, normalizedOptions, session) && !session.destroyed && !session.closed) {
									if (freeSession()) {
										closeCoveredSessions(this.freeSessions, normalizedOptions, session);
										closeCoveredSessions(this.busySessions, normalizedOptions, session);
										processListeners();
									} else {
										session.close();

										this.emit('close', session);
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

					removeFromQueue();
				}
			};

			entry.listeners = listeners;
			entry.completed = false;
			entry.destroyed = false;

			this.queue[normalizedOptions][normalizedAuthority] = entry;
			this._tryToCreateNewSession(normalizedOptions, normalizedAuthority);
		});
	}

	request(authority, options, headers) {
		return new Promise((resolve, reject) => {
			this.getSession(authority, options, [{
				reject,
				resolve: session => {
					resolve(session.request(headers));
				}
			}]);
		});
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

					this.emit('close', session);
				}
			}
		}
	}

	destroy(reason) {
		for (const busySessions of Object.values(this.busySessions)) {
			for (const session of busySessions) {
				session.destroy(reason);

				this.emit('close', session);
			}
		}

		for (const freeSessions of Object.values(this.freeSessions)) {
			for (const session of freeSessions) {
				session.destroy(reason);

				this.emit('close', session);
			}
		}

		for (const entriesOfAuthority of Object.values(this.queue)) {
			for (const entry of Object.values(entriesOfAuthority)) {
				entry.destroyed = true;
			}
		}

		// Further requests should queue to closing sessions
		this.queue = {};
	}
}

module.exports = {
	Agent,
	globalAgent: new Agent()
};
