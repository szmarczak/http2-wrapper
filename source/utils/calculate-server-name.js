'use strict';
const net = require('net');
/* istanbul ignore file: https://github.com/nodejs/node/blob/v12.10.0/lib/_http_agent.js */

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

	if (net.isIP(servername)) {
		return '';
	}

	return servername;
};
