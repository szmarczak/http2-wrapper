const o = {};

function makeid(length) {
	var result           = '';
	var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	var charactersLength = characters.length;
	for ( var i = 0; i < length; i++ ) {
	   result += characters.charAt(Math.floor(Math.random() * charactersLength));
	}
	return result;
 }

console.time('x');

if (false) {
	const ids = (new Array(100)).map(() => makeid(512));

	const results = [];

	for (let i = 0; i < 1000; i++) {
		const k = makeid(512);

		o[k] = {};

		for (const id of ids) {
			o[k][id] = Math.round(Math.random());
		}

		for (const id of ids) {
			results.push(Boolean(o[k][id]));
		}
	}
} else {
	let i = '';

	for (let x = 0; x < 1000; x++) {
		i += ':';

		if (Math.random() > 0.5) {
			i += makeid(512);
		}
	}
}

console.timeEnd('x');
console.log(Math.round(process.memoryUsage().heapUsed / 1024 / 1024), 'MB');

