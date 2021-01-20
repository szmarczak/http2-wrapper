'use strict';

module.exports = stream => {
	stream.__destroy = stream._destroy;
	stream._destroy = async (...args) => {
		const callback = args.pop();

		stream.__destroy(...args, async error => {
			await Promise.resolve();
			callback(error);
		});
	};
};
