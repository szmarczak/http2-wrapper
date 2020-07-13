'use strict';

class UnexpectedStatusCodeError extends Error {
	constructor(statusCode) {
		super(`The proxy server rejected the request with status code ${statusCode}`);
		this.statusCode = statusCode;
	}
}

module.exports = UnexpectedStatusCodeError;
