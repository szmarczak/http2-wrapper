'use strict';
/* istanbul ignore file: https://github.com/nodejs/node/blob/d4c91f28148af8a6c1a95392e5c88cb93d4b61c6/lib/_http_agent.js */

module.exports = (options, headers) => {
	let servername = options.host;
	const hostHeader = headers.host;

	if (hostHeader) {
		if (hostHeader.startsWith('[')) {
			const index = hostHeader.indexOf(']');
			if (index === -1) {
				servername = hostHeader;
			} else {
				servername = hostHeader.substr(1, index - 1);
			}
		} else {
			servername = hostHeader.split(':', 1)[0];
		}
	}

	return servername;
};
