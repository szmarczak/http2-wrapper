'use strict';
const EventEmitter = require('events');
const tls = require('tls');
const http2 = require('http2');
const QuickLRU = require('quick-lru');

const kCurrentStreamsCount = Symbol('currentStreamsCount');
const kRequest = Symbol('request');
const kOriginSet = Symbol('cachedOriginSet');

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
	if (name in where) {
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
	if (name in where) {
		where[name].push(session);
	} else {
		where[name] = [session];
	}
};

const getSessions = (where, name, normalizedOrigin) => {
	if (!(name in where)) {
		return [];
	}

	return where[name].filter(session => {
		return !session.closed && !session.destroyed && session[kOriginSet].includes(normalizedOrigin);
	});
};

// See https://tools.ietf.org/html/rfc8336
const closeCoveredSessions = (where, name, session) => {
	if (!(name in where)) {
		return;
	}

	// Clients SHOULD NOT emit new requests on any connection whose Origin
	// Set is a proper subset of another connection's Origin Set, and they
	// SHOULD close it once all outstanding requests are satisfied.
	for (const coveredSession of where[name]) {
		if (
			// The set is a proper subset when its length is less than the other set.
			coveredSession[kOriginSet].length < session[kOriginSet].length &&

			// And the other set includes all elements of the subset.
			coveredSession[kOriginSet].every(origin => session[kOriginSet].includes(origin)) &&

			// Makes sure that the session can handle all requests from the covered session.
			// TODO: can the session become uncovered when a stream is closed after checking this condition?
			coveredSession[kCurrentStreamsCount] + session[kCurrentStreamsCount] <= session.remoteSettings.maxConcurrentStreams
		) {
			// This allows pending requests to finish and prevents making new requests.
			coveredSession.close();
		}
	}
};

// This is basically inverted `closeCoveredSessions(...)`.
const closeSessionIfCovered = (where, name, coveredSession) => {
	if (!(name in where)) {
		return;
	}

	for (const session of where[name]) {
		if (
			coveredSession[kOriginSet].length < session[kOriginSet].length &&
			coveredSession[kOriginSet].every(origin => session[kOriginSet].includes(origin)) &&
			coveredSession[kCurrentStreamsCount] + session[kCurrentStreamsCount] <= session.remoteSettings.maxConcurrentStreams
		) {
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
		// QUEUE[NORMALIZED_OPTIONS][NORMALIZED_ORIGIN] = ENTRY_FUNCTION
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
		// TODO: should `maxFreeSessions` be related only to sessions with 0 pending streams?
		this.maxFreeSessions = maxFreeSessions;

		// We don't support push streams by default.
		this.settings = {
			enablePush: false
		};

		// Reusing TLS sessions increases performance.
		this.tlsSessionCache = new QuickLRU({maxSize: maxCachedTlsSessions});
	}

	static normalizeOrigin(url, servername) {
		if (typeof url === 'string') {
			url = new URL(url);
		}

		if (servername && url.hostname !== servername) {
			url.hostname = servername;
		}

		return url.origin;
	}

	normalizeOptions(options) {
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

	_tryToCreateNewSession(normalizedOptions, normalizedOrigin) {
		if (!(normalizedOptions in this.queue) || !(normalizedOrigin in this.queue[normalizedOptions])) {
			return;
		}

		// We need the busy sessions length to check if a session can be created.
		const busyLength = getSessions(this.busySessions, normalizedOptions, normalizedOrigin).length;
		const item = this.queue[normalizedOptions][normalizedOrigin];

		// The entry function can be run only once.
		if (busyLength < this.maxSessions && !item.completed) {
			item.completed = true;

			item();
		}
	}

	_closeCoveredSessions(normalizedOptions, session) {
		closeCoveredSessions(this.freeSessions, normalizedOptions, session);
		closeCoveredSessions(this.busySessions, normalizedOptions, session);
	}

	getSession(origin, options, listeners) {
		return new Promise((resolve, reject) => {
			if (Array.isArray(listeners)) {
				listeners = [...listeners];

				// Resolve the current promise ASAP, we're just moving the listeners.
				// They will be executed at a different time.
				resolve();
			} else {
				listeners = [{resolve, reject}];
			}

			const normalizedOptions = this.normalizeOptions(options);
			const normalizedOrigin = Agent.normalizeOrigin(origin, options && options.servername);

			if (normalizedOrigin === undefined) {
				for (const {reject} of listeners) {
					reject(new TypeError('The `origin` argument needs to be a string or an URL object'));
				}

				return;
			}

			if (normalizedOptions in this.freeSessions) {
				// Look for all available free sessions.
				const freeSessions = getSessions(this.freeSessions, normalizedOptions, normalizedOrigin);

				if (freeSessions.length !== 0) {
					// Use session which has the biggest stream capacity in order to use the smallest number of sessions possible.
					const session = freeSessions.reduce((previousSession, nextSession) => {
						if (
							nextSession.remoteSettings.maxConcurrentStreams >= previousSession.remoteSettings.maxConcurrentStreams &&
							nextSession[kCurrentStreamsCount] > previousSession[kCurrentStreamsCount]
						) {
							return nextSession;
						}

						return previousSession;
					});

					for (const {resolve} of listeners) {
						// TODO: The session can get busy here
						resolve(session);
					}

					return;
				}
			}

			if (normalizedOptions in this.queue) {
				if (normalizedOrigin in this.queue[normalizedOptions]) {
					// There's already an item in the queue, just attach ourselves to it.
					this.queue[normalizedOptions][normalizedOrigin].listeners.push(...listeners);

					return;
				}
			} else {
				this.queue[normalizedOptions] = {};
			}

			// The entry must be removed from the queue IMMEDIATELY when:
			// 1. the session connects successfully,
			// 2. an error occurs.
			const removeFromQueue = () => {
				// Our entry can be replaced. We cannot remove the new one.
				if (normalizedOptions in this.queue && this.queue[normalizedOptions][normalizedOrigin] === entry) {
					delete this.queue[normalizedOptions][normalizedOrigin];

					if (Object.keys(this.queue[normalizedOptions]).length === 0) {
						delete this.queue[normalizedOptions];
					}
				}
			};

			// The main logic is here
			const entry = () => {
				const name = `${normalizedOrigin}:${normalizedOptions}`;
				let receivedSettings = false;
				let servername;

				try {
					const tlsSessionCache = this.tlsSessionCache.get(name);

					const session = http2.connect(origin, {
						createConnection: this.createConnection,
						settings: this.settings,
						session: tlsSessionCache ? tlsSessionCache.session : undefined,
						...options
					});
					session[kCurrentStreamsCount] = 0;

					// Tries to free the session.
					const freeSession = () => {
						// Fetch the smallest amount of free sessions of any origin we have.
						const freeSessionsCount = session[kOriginSet].reduce((accumulator, origin) => {
							return Math.min(accumulator, getSessions(this.freeSessions, normalizedOptions, origin).length);
						}, Infinity);

						// Check the limit.
						if (freeSessionsCount < this.maxFreeSessions) {
							addSession(this.freeSessions, normalizedOptions, session);

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
							for (const {reject} of listeners) {
								reject(error);
							}
						}

						// The connection got broken, purge the cache.
						this.tlsSessionCache.delete(name);
					});

					session.setTimeout(this.timeout, () => {
						// Terminates all streams owned by this session.
						session.destroy();
					});

					session.once('close', () => {
						if (!receivedSettings) {
							// Broken connection
							const error = new Error('Session closed without receiving a SETTINGS frame');

							for (const {reject} of listeners) {
								reject(error);
							}
						}

						removeFromQueue();

						// This cannot be moved to the stream logic,
						// because there may be a session that hadn't made a single request.
						removeSession(this.freeSessions, normalizedOptions, session);

						// There may be another session awaiting.
						this._tryToCreateNewSession(normalizedOptions, normalizedOrigin);
					});

					// Iterates over the queue and processes listeners.
					const processListeners = () => {
						if (!(normalizedOptions in this.queue)) {
							return;
						}

						for (const origin of session[kOriginSet]) {
							if (origin in this.queue[normalizedOptions]) {
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
						session[kOriginSet] = session.originSet;

						if (!isFree()) {
							// The session is full.
							return;
						}

						// Close covered sessions (if possible).
						this._closeCoveredSessions(normalizedOptions, session);

						processListeners();

						// `session.remoteSettings.maxConcurrentStreams` might get increased
						session.on('remoteSettings', () => {
							this._closeCoveredSessions(normalizedOptions, session);
						});
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

						session[kOriginSet] = session.originSet;
						this.emit('session', session);

						if (freeSession()) {
							// Process listeners, we're free.
							processListeners();
						} else if (this.maxFreeSessions === 0) {
							processListeners();

							// We're closing ASAP, when all possible requests have been made for this event loop tick.
							setImmediate(() => {
								session.close();
							});
						} else {
							// Too late, another free session took these listeners.
							session.close();
						}

						removeFromQueue();

						// Check if we haven't managed to execute all listeners.
						if (listeners.length !== 0) {
							// Request for a new session with predefined listeners.
							this.getSession(normalizedOrigin, options, listeners);
							listeners.length = 0;
						}

						receivedSettings = true;

						// `session.remoteSettings.maxConcurrentStreams` might get increased
						session.on('remoteSettings', () => {
							// Check if we're eligible to become a free session
							if (isFree() && removeSession(this.busySessions, normalizedOptions, session)) {
								// Check for free seats
								if (freeSession()) {
									processListeners();
								} else {
									// Assume it's still a busy session
									addSession(this.busySessions, normalizedOptions, session);
								}
							}
						});
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
										this._closeCoveredSessions(normalizedOptions, session);
										processListeners();
									} else {
										session.close();
									}
								}
							}

							if (!session.destroyed && !session.closed) {
								closeSessionIfCovered(this.freeSessions, normalizedOptions, session);
							}
						});

						return stream;
					};
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

			this.queue[normalizedOptions][normalizedOrigin] = entry;
			this._tryToCreateNewSession(normalizedOptions, normalizedOrigin);
		});
	}

	request(origin, options, headers) {
		return new Promise((resolve, reject) => {
			this.getSession(origin, options, [{
				reject,
				resolve: session => {
					resolve(session.request(headers));
				}
			}]);
		});
	}

	createConnection(origin, options) {
		return Agent.connect(origin, options);
	}

	static connect(origin, options) {
		options.ALPNProtocols = ['h2'];

		const port = origin.port || 443;
		const host = origin.hostname || origin.host;

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

		for (const entriesOfAuthority of Object.values(this.queue)) {
			for (const entry of Object.values(entriesOfAuthority)) {
				entry.destroyed = true;
			}
		}

		// New requests should NOT attach to destroyed sessions
		this.queue = {};
	}
}

module.exports = {
	Agent,
	globalAgent: new Agent()
};
