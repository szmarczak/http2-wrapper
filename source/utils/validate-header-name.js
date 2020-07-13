'use strict';
const {ERR_INVALID_HTTP_TOKEN} = require('./errors');
const isRequestPseudoHeader = require('./is-request-pseudo-header');

const isValidHttpToken = /^[\^`\-\w!#$%&*+.|~]+$/;

module.exports = name => {
	if (typeof name !== 'string' || (!isValidHttpToken.test(name) && !isRequestPseudoHeader(name))) {
		throw new ERR_INVALID_HTTP_TOKEN('Header name', name);
	}
};
