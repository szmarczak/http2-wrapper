'use strict';
// See https://github.com/facebook/jest/issues/2549
// eslint-disable-next-line node/prefer-global/url
const {URL} = require('url');
const checkType = require('../utils/check-type');

module.exports = (self, proxyOptions = {}) => {
	const url = new URL(proxyOptions.url);
	const {raw} = proxyOptions;

	checkType('proxyOptions', proxyOptions, ['object', 'undefined']);
	checkType('proxyOptions.headers', proxyOptions.headers, ['object', 'undefined']);
	checkType('proxyOptions.raw', raw, ['boolean', 'undefined']);
	checkType('proxyOptions.url', url, [URL, 'string', 'undefined']);

	self.proxyOptions = {
		...proxyOptions,
		headers: {...proxyOptions.headers},
		url,
		raw: raw === undefined ? true : Boolean(raw)
	};
};
