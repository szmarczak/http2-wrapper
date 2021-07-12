'use strict';
const http2 = require('../source/index.js'); // Note: using the local version

class MyAgent extends http2.Agent {
	createConnection(origin, options) {
		console.log(`Connecting to ${origin}`);
		return http2.Agent.connect(origin, options);
	}
}

http2.get({
	hostname: 'google.com',
	agent: new MyAgent()
}, response => {
	response.on('data', chunk => console.log(`Received chunk of ${chunk.length} bytes`));
});
