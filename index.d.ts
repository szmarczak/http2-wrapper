import {EventEmitter} from 'events';
import {TLSSocket} from 'tls';
import http = require('http');
import {RequestOptions} from 'https';
import http2 = require('http2');
import QuickLRU from 'quick-lru';

export interface AgentOptions {
	timeout?: number;
	maxSessions?: number;
	maxFreeSessions?: number;
	maxCachedTlsSessions?: number;
}

export interface PromiseListeners {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export class Agent extends EventEmitter {
	freeSessions: {[key: string]: http2.ClientHttp2Stream[]};
	busySessions: {[key: string]: http2.ClientHttp2Stream[]};

	constructor(options: AgentOptions);

	static normalizeOrigin(url: string | URL, servername?: string): string;

	static connect(origin: URL, options: http2.SecureClientSessionOptions): TLSSocket;

	normalizeOptions(options: http2.ClientSessionRequestOptions): string;

	getSession(origin: string | URL, options?: http2.SecureClientSessionOptions, listeners?: PromiseListeners): Promise<http2.ClientHttp2Session>;
	request(origin: string | URL, options?: http2.SecureClientSessionOptions, headers?: http2.OutgoingHttpHeaders, streamOptions?: http2.ClientSessionRequestOptions): Promise<http2.ClientHttp2Stream>;

	createConnection(origin: URL, options: http2.SecureClientSessionOptions): TLSSocket;

	closeFreeSessions(): void;
	destroy(reason?: Error): void;
}

export interface RequestFunction<T> {
	(url: string | URL, options: RequestOptions, callback?: (response: IncomingMessage) => void): T;
	(options: RequestOptions, callback?: (response: IncomingMessage) => void): T;
}

export import ClientRequest = http.ClientRequest;
export import IncomingMessage = http.IncomingMessage;

export const globalAgent: Agent;

export const request: RequestFunction<ClientRequest>;
export const get: RequestFunction<ClientRequest>;
export const auto: RequestFunction<Promise<ClientRequest>> & {protocolCache: QuickLRU<string, string>};

export * from 'http2';
