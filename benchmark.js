'use strict';
const http2 = require('http2');
const https = require('https');
const http = require('http');
const Benchmark = require('benchmark');
const urlToOptions = require('./source/utils/url-to-options');
const wrapper = require('./source');

// Configuration
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const destination = new URL('https://localhost:8081');
const destinationHTTP = new URL('http://localhost:8080');

// Benchmarking
const suite = new Benchmark.Suite();

const session = http2.connect(destination);
const wrapperSession = http2.connect(destination);

const destinationOpts = urlToOptions(destination);
const destinationOptsWithSession = {
	...destinationOpts,
	h2session: wrapperSession
};
const destinationHTTPOpts = urlToOptions(destinationHTTP);

const httpsKeepAlive = {
	agent: new https.Agent({keepAlive: true})
};

const autoHttpsKeepAlive = {
	ALPNProtocols: ['http/1.1'],
	agent: {
		https: new https.Agent({keepAlive: true})
	}
};

suite.add('http2-wrapper', {
	defer: true,
	fn: deferred => {
		wrapper.get(destinationOpts, response => {
			response.resume();
			response.once('end', () => {
				deferred.resolve();
			});
		});
	}
}).add('http2-wrapper - preconfigured session', {
	defer: true,
	fn: deferred => {
		wrapper.get(destinationOptsWithSession, response => {
			response.resume();
			response.once('end', () => {
				deferred.resolve();
			});
		});
	},
	onComplete: () => {
		wrapperSession.close();
	}
}).add('http2-wrapper - auto', {
	defer: true,
	fn: async deferred => {
		(await wrapper.auto(destinationOpts, response => {
			response.resume();
			response.once('end', () => {
				deferred.resolve();
			});
		})).end();
	}
}).add('http2', {
	defer: true,
	fn: deferred => {
		const stream = session.request();
		stream.resume();
		stream.once('end', () => {
			deferred.resolve();
		});
	}
}).add('https - auto - keepalive', {
	defer: true,
	fn: async deferred => {
		(await wrapper.auto(destinationOpts, autoHttpsKeepAlive, response => {
			response.resume();
			response.once('end', () => {
				deferred.resolve();
			});
		})).end();
	}
}).add('https - keepalive', {
	defer: true,
	fn: deferred => {
		// If we use `destinationOpts` here, we get `socket hung up` errors for no reason <!>
		https.get(destination, httpsKeepAlive, response => {
			response.resume();
			response.once('end', () => {
				deferred.resolve();
			});
		});
	}
}).add('https', {
	defer: true,
	fn: deferred => {
		// If we use `destinationOpts` here, we get `socket hung up` errors for no reason <!>
		https.get(destination, response => {
			response.resume();
			response.once('end', () => {
				deferred.resolve();
			});
		});
	}
}).add('http', {
	defer: true,
	fn: deferred => {
		http.get(destinationHTTPOpts, response => {
			response.resume();
			response.once('end', () => {
				deferred.resolve();
			});
		});
	}
}).on('cycle', event => {
	console.log(String(event.target));
}).on('complete', function () {
	console.log(`Fastest is ${this.filter('fastest').map('name')}`);

	// eslint-disable-next-line unicorn/no-process-exit
	process.exit(0);
}).run({
	async: false
});
