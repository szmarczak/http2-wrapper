'use strict';
const {setImmediate} = require('timers');

module.exports = () => new Promise(resolve => {
	setImmediate(resolve);
});
