'use strict';
const assert = require('assert');

module.exports = host => {
	// Note: 1.1.1.1 is a valid servername as well!

	if (host[0] === '[') {
		const idx = host.indexOf(']');

		assert(idx !== -1);
		return host.slice(1, idx);
	}

	const idx = host.indexOf(':');
	if (idx === -1) {
		return host;
	}

	return host.slice(0, idx);
};
