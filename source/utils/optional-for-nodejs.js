'use strict';

const [major, minor, patch] = process.versions.node.split('.').map(x => Number(x));

module.exports = (source, optional, requiredVersion) => {
	const [requiredMajor, requiredMinor, requiredPatch] = requiredVersion.split('.').map(x => Number(x));

	let supported = false;

	if (major === requiredMajor) {
		if (minor === requiredMinor) {
			if (patch >= requiredPatch) {
				supported = true;
			}
		} else if (minor > requiredMinor) {
			supported = true;
		}
	} else if (major > requiredMajor) {
		supported = true;
	}

	if (!supported) {
		source = {...source};

		for (const key in optional) {
			Object.defineProperty(source, key, {
				get: () => {
					throw new Error(`Required Node.js version: ${requiredVersion} (current: ${process.versions.node})`);
				}
			});
		}

		return source;
	}

	return {
		...source,
		...optional
	};
};
