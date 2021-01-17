'use strict';

const checkType = (name, value, types) => {
	const valid = types.some(type => {
		const typeofType = typeof type;
		if (typeofType === 'string') {
			return typeof value === type;
		}

		return value instanceof type;
	});

	if (!valid) {
		throw new TypeError(`Expected '${name}' to be a type of ${types.join(' or ')}, got ${typeof value}`);
	}
};

module.exports = checkType;
