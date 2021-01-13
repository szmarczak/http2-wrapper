'use strict';
const assert = require('assert');
const os = require('os');
const cluster = require('cluster');

const cpus = os.cpus().length;
const instances = 1;

if (cluster.isMaster) {
	let counter = 0;

	console.log('Creating servers...');

	for (let index = 0; index < instances; index++) {
		const worker = cluster.fork();

		worker.on('message', message => {
			assert.strictEqual(message, 'ok');

			if (++counter === instances) {
				console.log('Starting benchmark...');
				require('./client');
			}
		});
	}
} else {
	require('./server');
}
