'use strict';
/* istanbul ignore file: https://github.com/nodejs/node/blob/v13.0.1/lib/_http_agent.js */

module.exports = options => {
	let servername = options.host;
	const hostHeader = options.headers && options.headers.host;

	if (hostHeader) {
		if (hostHeader.startsWith('[')) {
			const index = hostHeader.indexOf(']');
			servername = index === -1 ? hostHeader : hostHeader.slice(1, -1);
		} else {
			servername = hostHeader.split(':', 1)[0];
		}
	}

	// Removed empty string return for IP,
	// otherwise https://1.1.1.1/ would fail.

	return servername;
};
