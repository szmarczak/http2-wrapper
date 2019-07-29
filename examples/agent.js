'use strict';
const http2 = require('../source'); // Note: using local version

class MyAgent extends http2.Agent {
	createConnection(authority, options) {
		console.log(`Connecting to ${authority}`);
		return http2.Agent.connect(authority, options);
	}
}

http2.get({
	hostname: 'google.com',
	agent: new MyAgent()
}, res => {
	res.on('data', chunk => console.log(`Received chunk of ${chunk.length} bytes`));
});
