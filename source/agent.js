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

// See https://tools.ietf.org/html/rfc8336
const closeCoveredSessions = (where, name, session) => {
	if (!Reflect.has(where, name)) {
		return;
	}

	// Clients SHOULD NOT emit new requests on any connection whose Origin
	// Set is a proper subset of another connection's Origin Set, and they
	// SHOULD close it once all outstanding requests are satisfied.
	for (const coveredSession of where[name]) {
		if (
			// The set is a proper subset when its length is less than the other set.
			coveredSession.originSet.length < session.originSet.length &&

			// And the other set includes all elements of the subset.
			coveredSession.originSet.every(origin => session.originSet.includes(origin)) &&

			// Makes sure that the session can handle all requests from the covered session.
			// TODO: can the session become uncovered when a stream is closed after checking this condition?
			coveredSession[kCurrentStreamsCount] + session[kCurrentStreamsCount] <= session.remoteSettings.maxConcurrentStreams
		) {
			// This allows pending requests to finish and prevents making new requests.
			coveredSession.close();
		}
	}
};

class Agent extends EventEmitter {
	constructor({timeout = 60000, maxSessions = Infinity, maxFreeSessions = 1, maxCachedTlsSessions = 100} = {}) {
		super();

		// A session is considered busy when its current streams count
		// is equal to or greater than the `maxConcurrentStreams` value.
		this.busySessions = {};

		// A session is considered free when its current streams count
		// is less than the `maxConcurrentStreams` value.
		this.freeSessions = {};

		// The queue for creating new sessions. It looks like this:
		// QUEUE[NORMALIZED_OPTIONS][NORMALIZED_AUTHORITY] = ENTRY_FUNCTION
		//
		// The entry function has `listeners`, `completed` and `destroyed` properties.
		// `listeners` is an array of objects containing `resolve` and `reject` functions.
		// `completed` is a boolean. It's set to true after ENTRY_FUNCTION is executed.
		// `destroyed` is a boolean. If it's set to true, the session will be destroyed if hasn't connected yet.
		this.queue = {};

		// Each session will use this timeout value.
		this.timeout = timeout;

		// Max sessions per origin.
		this.maxSessions = maxSessions;

		// Max free sessions per origin.
		// TODO: decreasing `maxFreeSessions` should close some sessions
		this.maxFreeSessions = maxFreeSessions;

		// We don't support push streams by default.
		this.settings = {
			enablePush: false
		};

		// Reusing TLS sessions increases performance.
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

		// We need the busy sessions length to check if a session can be created.
		const busyLength = getSessions(this.busySessions, normalizedOptions, normalizedAuthority).length;
		const item = this.queue[normalizedOptions][normalizedAuthority];

		// The entry function can be run only once.
		if (busyLength < this.maxSessions && !item.completed) {
			item.completed = true;

			item();
		}
	}

	getSession(authority, options, listeners) {
		return new Promise((resolve, reject) => {
			if (Array.isArray(listeners)) {
				listeners = [...listeners];

				// Resolve the current promise ASAP, we're just moving the listeners.
				// They will be executed at a different time.
				resolve();
			} else {
				listeners = [{resolve, reject}];
			}

			const normalizedOptions = Agent.normalizeOptions(options);
			const normalizedAuthority = Agent.normalizeAuthority(authority, options && options.servername);

			if (Reflect.has(this.freeSessions, normalizedOptions)) {
				// Look for all available free sessions.
				const freeSessions = getSessions(this.freeSessions, normalizedOptions, normalizedAuthority);

				if (freeSessions.length !== 0) {
					// Use session which has the biggest stream capacity in order to use the smallest number of sessions possible.
					const session = freeSessions.reduce((previousSession, nextSession) => {
						if (nextSession.remoteSettings.maxConcurrentStreams > previousSession.remoteSettings.maxConcurrentStreams) {
							return nextSession;
						}

						return previousSession;
					});

					for (const listener of listeners) {
						listener.resolve(session);
					}

					return;
				}
			}

			if (Reflect.has(this.queue, normalizedOptions)) {
				if (Reflect.has(this.queue[normalizedOptions], normalizedAuthority)) {
					// There's already an item in the queue, just attach ourselves to it.
					this.queue[normalizedOptions][normalizedAuthority].listeners.push(...listeners);

					return;
				}
			} else {
				this.queue[normalizedOptions] = {};
			}

			// The entry must be removed from the queue IMMEDIATELY when:
			// 1. a session connects successfully,
			// 2. an error occurs.
			const removeFromQueue = () => {
				// Our entry can be replaced. We cannot remove the new one.
				if (Reflect.has(this.queue, normalizedOptions) && this.queue[normalizedOptions][normalizedAuthority] === entry) {
					delete this.queue[normalizedOptions][normalizedAuthority];

					if (Object.keys(this.queue[normalizedOptions]).length === 0) {
						delete this.queue[normalizedOptions];
					}
				}
			};

			// The main logic is here
			const entry = () => {
				const name = `${normalizedAuthority}:${normalizedOptions}`;
				let receivedSettings = false;
				let servername;

				try {
					const tlsSessionCache = this.tlsSessionCache.get(name);

					const session = http2.connect(authority, {
						createConnection: this.createConnection,
						settings: this.settings,
						session: tlsSessionCache ? tlsSessionCache.session : undefined,
						...options
					});
					session[kCurrentStreamsCount] = 0;

					// Tries to free the session.
					const freeSession = () => {
						// Fetch the smallest amount of free sessions of any origin we have.
						const freeSessionsCount = session.originSet.reduce((accumulator, origin) => {
							return Math.min(accumulator, getSessions(this.freeSessions, normalizedOptions, origin).length);
						}, Infinity);

						// Check the limit.
						if (freeSessionsCount < this.maxFreeSessions) {
							addSession(this.freeSessions, normalizedOptions, session);

							this.emit('free', session);
							return true;
						}

						return false;
					};

					const isFree = () => session[kCurrentStreamsCount] < session.remoteSettings.maxConcurrentStreams;

					session.socket.once('session', tlsSession => {
						// We need to cache the servername due to a bug in OpenSSL.
						setImmediate(() => {
							this.tlsSessionCache.set(name, {
								session: tlsSession,
								servername
							});
						});
					});

					// OpenSSL bug workaround.
					// See https://github.com/nodejs/node/issues/28985
					session.socket.once('secureConnect', () => {
						servername = session.socket.servername;

						if (servername === false && typeof tlsSessionCache !== 'undefined' && typeof tlsSessionCache.servername !== 'undefined') {
							session.socket.servername = tlsSessionCache.servername;
						}
					});

					session.once('error', error => {
						// `receivedSettings` is true when the session has successfully connected.
						if (!receivedSettings) {
							for (const listener of listeners) {
								listener.reject(error);
							}
						}

						// The connection got broken, purge the cache.
						this.tlsSessionCache.delete(name);
					});

					session.setTimeout(this.timeout, () => {
						// Terminates all streams owned by this session.
						session.destroy();

						this.emit('close', session);
					});

					session.once('close', () => {
						if (!receivedSettings) {
							// Broken connection
							const error = new Error('Session closed without receiving a SETTINGS frame');

							for (const listener of listeners) {
								listener.reject(error);
							}
						}

						removeFromQueue();

						// This cannot be moved to the stream logic,
						// because there may be a session that hadn't made a single request.
						removeSession(this.freeSessions, normalizedOptions, session);

						// There may be another session awaiting.
						this._tryToCreateNewSession(normalizedOptions, normalizedAuthority);
					});

					// Iterates over the queue and processes listeners.
					const processListeners = () => {
						if (!Reflect.has(this.queue, normalizedOptions)) {
							return;
						}

						for (const origin of session.originSet) {
							if (Reflect.has(this.queue[normalizedOptions], origin)) {
								const {listeners} = this.queue[normalizedOptions][origin];

								// Prevents session overloading.
								while (listeners.length !== 0 && isFree()) {
									// We assume `resolve(...)` calls `request(...)` *directly*,
									// otherwise the session will get overloaded.
									listeners.shift().resolve(session);
								}

								if (this.queue[normalizedOptions][origin].listeners.length === 0) {
									delete this.queue[normalizedOptions][origin];

									if (Object.keys(this.queue[normalizedOptions]).length === 0) {
										delete this.queue[normalizedOptions];
										break;
									}
								}

								// We're no longer free, no point in continuing.
								if (!isFree()) {
									break;
								}
							}
						}
					};

					// The Origin Set cannot shrink. No need to check if it suddenly became covered by another one.
					session.once('origin', () => {
						if (!isFree()) {
							// The session is full.
							return;
						}

						// Close covered sessions (if possible).
						closeCoveredSessions(this.freeSessions, normalizedOptions, session);
						closeCoveredSessions(this.busySessions, normalizedOptions, session);

						processListeners();
					});

					session.once('remoteSettings', () => {
						// The Agent could have been destroyed already.
						if (entry.destroyed) {
							const error = new Error('Agent has been destroyed');

							for (const listener of listeners) {
								listener.reject(error);
							}

							session.destroy();
							return;
						}

						if (freeSession()) {
							// Process listeners, we're free.
							processListeners();
						} else if (this.maxFreeSessions === 0) {
							processListeners();

							// We're closing ASAP, when all possible requests have been made for this event loop tick.
							setImmediate(() => {
								session.close();

								this.emit('close', session);
							});
						} else {
							// Too late, no seats available, close the session.
							session.close();

							this.emit('close', session);
						}

						removeFromQueue();

						// Check if we haven't managed to execute all listeners.
						if (listeners.length !== 0) {
							// Request for a new session with predefined listeners.
							this.getSession(normalizedAuthority, options, listeners);
							listeners.length = 0;
						}

						receivedSettings = true;
					});

					// Shim `session.request()` in order to catch all streams
					session[kRequest] = session.request;
					session.request = headers => {
						const stream = session[kRequest](headers, {
							endStream: false
						});

						// The process won't exit until the session is closed.
						session.ref();

						++session[kCurrentStreamsCount];

						// Check if we became busy
						if (!isFree() && removeSession(this.freeSessions, normalizedOptions, session)) {
							addSession(this.busySessions, normalizedOptions, session);

							this.emit('busy', session);
						}

						stream.once('close', () => {
							--session[kCurrentStreamsCount];

							if (isFree()) {
								if (session[kCurrentStreamsCount] === 0) {
									// All requests are finished, the process may exit now.
									session.unref();
								}

								// Check if we are no longer busy and the session is not broken.
								if (removeSession(this.busySessions, normalizedOptions, session) && !session.destroyed && !session.closed) {
									// Check the sessions count of this authority and compare it to `maxSessionsCount`.
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

		// New requests should NOT attach themselves to destroyed sessions
		this.queue = {};
	}
}

module.exports = {
	Agent,
	globalAgent: new Agent()
};
