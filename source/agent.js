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

const getSortedIndex = (array, value, compare) => {
	let low = 0;
	let high = array.length;

	while (low < high) {
		let mid = (low + high) >>> 1;

		if (compare(array[mid], value)) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}

	return low;
};

const compareSessions = (a, b) => {
	return a.remoteSettings.maxConcurrentStreams > b.remoteSettings.maxConcurrentStreams;
};

// See https://tools.ietf.org/html/rfc8336
const closeCoveredSessions = (where, session) => {
	// Clients SHOULD NOT emit new requests on any connection whose Origin
	// Set is a proper subset of another connection's Origin Set, and they
	// SHOULD close it once all outstanding requests are satisfied.
	for (const coveredSession of where) {
		if (
			// The set is a proper subset when its length is less than the other set.
			coveredSession[kOriginSet].length < session[kOriginSet].length &&

			// And the other set includes all elements of the subset.
			coveredSession[kOriginSet].every(origin => session[kOriginSet].includes(origin)) &&

			// Makes sure that the session can handle all requests from the covered session.
			coveredSession[kCurrentStreamsCount] + session[kCurrentStreamsCount] <= session.remoteSettings.maxConcurrentStreams
		) {
			// This allows pending requests to finish and prevents making new requests.
			coveredSession.close();
		}
	}
};

// This is basically inverted `closeCoveredSessions(...)`.
const closeSessionIfCovered = (where, coveredSession) => {
	for (const session of where) {
		if (
			coveredSession[kOriginSet].length < session[kOriginSet].length &&
			coveredSession[kOriginSet].every(origin => session[kOriginSet].includes(origin)) &&
			coveredSession[kCurrentStreamsCount] + session[kCurrentStreamsCount] <= session.remoteSettings.maxConcurrentStreams
		) {
			coveredSession.close();
		}
	}
};

const getSessions = ({agent, isFree}) => {
	const result = {};

	for (const normalizedOptions in agent.sessions) {
		const sessions = agent.sessions[normalizedOptions];

		const filtered = sessions.filter(session => {
			const result = session[Agent.kCurrentStreamsCount] < session.remoteSettings.maxConcurrentStreams;

			return isFree ? result : !result;
		});

		if (filtered.length !== 0) {
			result[normalizedOptions] = filtered;
		}
	}

	return result;
};

class Agent extends EventEmitter {
	constructor({timeout = 60000, maxSessions = Infinity, maxFreeSessions = 10, maxCachedTlsSessions = 100} = {}) {
		super();

		// A session is considered busy when its current streams count
		// is equal to or greater than the `maxConcurrentStreams` value.

		// A session is considered free when its current streams count
		// is less than the `maxConcurrentStreams` value.

		// SESSIONS[NORMALIZED_OPTIONS] = [];
		this.sessions = {};

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

		// Max sessions in total
		this.maxSessions = maxSessions;

		// Max free sessions in total
		// TODO: decreasing `maxFreeSessions` should close some sessions
		this.maxFreeSessions = maxFreeSessions;

		this._freeSessionsCount = 0;
		this._sessionsCount = 0;

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

		const item = this.queue[normalizedOptions][normalizedOrigin];

		// The entry function can be run only once.
		// BUG: The session may be never created when:
		// - the first condition is false AND
		// - this function is never called with the same arguments in the future.
		if (this._sessionsCount < this.maxSessions && !item.completed) {
			item.completed = true;

			item();
		}
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

			// [1]
			if (normalizedOptions in this.sessions) {
				const sessions = this.sessions[normalizedOptions];

				let maxConcurrentStreams = -1;
				let optimalSession;

				// We could just do this.sessions[normalizedOptions].find(...) but that isn't optimal.
				// Additionally, we are looking for session which has biggest current pending streams count.
				for (const session of sessions) {
					if (session[kOriginSet].includes(normalizedOrigin)) {
						const sessionMaxConcurrentStreams = session.remoteSettings.maxConcurrentStreams;

						if (
							sessionMaxConcurrentStreams < maxConcurrentStreams ||
							// Unfortunately the `close` event isn't called immediately,
							// so `session.destroyed` is `true`, but `session.closed` is `false`.
							session.destroyed
						) {
							break;
						}

						if (session[kCurrentStreamsCount] >= sessionMaxConcurrentStreams) {
							continue;
						}

						// We only need set this once.
						if (!optimalSession) {
							maxConcurrentStreams = sessionMaxConcurrentStreams;
						}

						optimalSession = session;
					}
				}

				if (optimalSession) {
					// Use session which has the biggest stream capacity in order to use the smallest number of sessions possible.

					while (listeners.length !== 0) {
						const {resolve} = listeners.shift();
						resolve(optimalSession);

						// TODO: Instead of calling getSessions, redo [1].
						if (optimalSession[kCurrentStreamsCount] === maxConcurrentStreams && listeners.length !== 0) {
							getSessions(normalizedOptions, normalizedOrigin, listeners);
							return;
						}
					}
				}
			}

			if (normalizedOptions in this.queue) {
				if (normalizedOrigin in this.queue[normalizedOptions]) {
					// There's already an item in the queue, just attach ourselves to it.
					this.queue[normalizedOptions][normalizedOrigin].listeners.push(...listeners);

					// This shouldn't be executed here.
					// See the comment inside _tryToCreateNewSession.
					this._tryToCreateNewSession(normalizedOptions, normalizedOrigin);
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
						// Listeners are empty when the session successfully connected.
						for (const {reject} of listeners) {
							reject(error);
						}

						// The connection got broken, purge the cache.
						this.tlsSessionCache.delete(name);
					});

					session.setTimeout(this.timeout, () => {
						// Terminates all streams owned by this session.
						// TODO: Maybe the streams should have a "Session timed out" error?
						session.destroy();
					});

					session.once('close', () => {
						if (!receivedSettings) {
							// Broken connection
							const error = new Error('Session closed without receiving a SETTINGS frame');
							error.code = 'HTTP2WRAPPER_NOSETTINGS';

							for (const {reject} of listeners) {
								reject(error);
							}
						}

						if (isFree()) {
							this._freeSessionsCount--;
						}

						this._sessionsCount--;

						removeFromQueue();

						// This cannot be moved to the stream logic,
						// because there may be a session that hadn't made a single request.
						if (normalizedOptions in this.sessions) {
							const where = this.sessions[normalizedOptions];
							const index = where.indexOf(session);

							if (index !== -1) {
								where.splice(index, 1);

								if (where.length === 0) {
									delete this.sessions[normalizedOptions];
								}
							}
						}

						// There may be another session awaiting.
						this._tryToCreateNewSession(normalizedOptions, normalizedOrigin);
					});

					// Iterates over the queue and processes listeners.
					const processListeners = () => {
						if (!(normalizedOptions in this.queue) || !isFree()) {
							return false;
						}

						let result = false;

						for (const origin of session[kOriginSet]) {
							if (origin in this.queue[normalizedOptions]) {
								const {listeners} = this.queue[normalizedOptions][origin];

								// Prevents session overloading.
								const accept = () => listeners.length !== 0 && isFree();

								if (accept()) {
									result = true;
								}

								while (accept()) {
									// We assume `resolve(...)` calls `request(...)` *directly*,
									// otherwise the session will get overloaded.
									listeners.shift().resolve(session);
								}

								const where = this.queue[normalizedOptions];
								if (where[origin].listeners.length === 0) {
									delete where[origin];

									if (Object.keys(where).length === 0) {
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

						return result;
					};

					// The Origin Set cannot shrink. No need to check if it suddenly became covered by another one.
					session.on('origin', () => {
						session[kOriginSet] = session.originSet;

						if (!isFree()) {
							// The session is full.
							return;
						}

						processListeners();

						// Close covered sessions (if possible).
						closeCoveredSessions(this.sessions[normalizedOptions], session);
					});

					session.once('remoteSettings', () => {
						// Fix Node.js bug preventing the process from exiting
						session.ref();
						session.unref();

						this._sessionsCount++;

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

						{
							const where = this.sessions;

							if (normalizedOptions in where) {
								const sessions = where[normalizedOptions];
								sessions.splice(getSortedIndex(sessions, session, compareSessions), 0, session);
							} else {
								where[normalizedOptions] = [session];
							}
						}

						this._freeSessionsCount += 1;

						this.emit('session', session);

						processListeners();

						// TODO: Close last recently used (or least used?) session
						if (session[kCurrentStreamsCount] === 0 && this._freeSessionsCount > this.maxFreeSessions) {
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
							processListeners();

							// In case the Origin Set changes
							closeCoveredSessions(this.sessions[normalizedOptions], session);
						});
					});

					// Shim `session.request()` in order to catch all streams
					session[kRequest] = session.request;
					session.request = (headers, streamOptions) => {
						const stream = session[kRequest](headers, streamOptions);

						// The process won't exit until the session is closed or all requests are gone.
						session.ref();

						++session[kCurrentStreamsCount];

						if (session[kCurrentStreamsCount] === session.remoteSettings.maxConcurrentStreams) {
							this._freeSessionsCount--;
						}

						stream.once('close', () => {
							const wasFree = isFree();

							--session[kCurrentStreamsCount];

							if (!session.destroyed && !session.closed) {
								closeSessionIfCovered(this.sessions[normalizedOptions], session);

								if (isFree() && !session.closed) {
									if (!wasFree) {
										this._freeSessionsCount++;
									}

									const isEmpty = session[kCurrentStreamsCount] === 0;

									if (isEmpty) {
										session.unref();
									}

									if (
										isEmpty &&
										this._freeSessionsCount > this.maxFreeSessions
									) {
										session.close();
									} else {
										closeCoveredSessions(this.sessions[normalizedOptions], session);
										processListeners();
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

	request(origin, options, headers, streamOptions) {
		return new Promise((resolve, reject) => {
			this.getSession(origin, options, [{
				reject,
				resolve: session => {
					try {
						resolve(session.request(headers, streamOptions));
					} catch (error) {
						reject(error);
					}
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
		for (const sessions of Object.values(this.sessions)) {
			for (const session of sessions) {
				if (session[kCurrentStreamsCount] === 0) {
					session.close();
				}
			}
		}
	}

	destroy(reason) {
		for (const sessions of Object.values(this.sessions)) {
			for (const session of sessions) {
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

	get freeSessions() {
		return getSessions({agent: this, isFree: true});
	}

	get busySessions() {
		return getSessions({agent: this, isFree: false});
	}
}

Agent.kCurrentStreamsCount = kCurrentStreamsCount;

module.exports = {
	Agent,
	globalAgent: new Agent()
};
