const http2 = require('.');

(async () => {
	const session = http2.connect('https://google.com');
	session.ref();
	session.unref();

	session.ref();

	const request = session.request();
	request.resume();
	request.once('end', () => {
		session.unref();
		console.log('got read');
	});
	return;
    const url = 'https://www.facebook.com/video/autoplay/nux/';

    const headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36',
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com',
        'cache-control': 'no-cache',
		'accept-language': 'en-US,en',
		'content-type': 'application/x-www-form-urlencoded'
	};

    const form = {
        "__user":"0",
        "__a":"1",
        "__dyn":"7xeUmLwjbgmg9odoKEaVuC1swXCwAxu13wqovzErxuEc8uKewhE4mdwJx64e2u3mcw9m3y4o3Bwxxm0xU5y1wKE4W15w8i1rwnEszU2rxK4obHxK8wgolzUOmVo7y1NwgEcHzoaEaoGqfw8u1txm2l2Utwwwi83NwKwFxe0H8-7Eoxmm1Dwdq1iwmE",
        "__csr":"",
        "__req":"1",
        "__beoa":"0",
        "__pc":"PHASED:DEFAULT",
        "dpr":"1",
        "__ccg":"GOOD",
        "__rev":"1002161514",
        "__s":"u7q08f:t588bh:qe2d9f",
        "__hsi":"6830736561003934072-0",
        "__comet_req":"0",
        "lsd":"AVpPhxkG",
        "jazoest":"2745",
        "__spin_r":"1002161514",
        "__spin_b":"trunk",
        "__spin_t":"1590404790"
    };

	const body = (new URLSearchParams(form)).toString();

	// const session = http2.connect('https://facebook.com');

	// session.once('remoteSetings', () => {
	// 	const request = session.request({
	// 		':method': 'POST',
	// 		...headers
	// 	});

	// 	request.once('error', console.error);

	// 	session.close();
	// });

	// return;

	const sendRequest = () => new Promise((resolve, reject) => {
		const request = http2.request(url, {
			method: 'POST',
			headers
		});
		request.end(body);

		request.once('error', error => {
			error.request = request;
			reject(error);
		});

		const data = [];
		request.once('response', response => {
			response.on('data', chunk => {
				data.push(chunk);
			});

			response.once('end', () => {
				resolve(Buffer.concat(data).toString());
			});
		});
	});

    const result = [];

    const test = async (name, n, func) => {
        const errors = new Set();
        const time = Date.now();
        let success = 0;
		let fail = 0;

        await Promise.all(new Array(n).fill(0).map(async () => {
            try {
                await func();
                success++;
            } catch (e) {
				const free = http2.globalAgent.freeSessions[''];
				const busy = http2.globalAgent.busySessions[''];
				// console.log(
				// 	free && free[0][http2.kCurrentStreamsCount],
				// 	busy && busy.length,
				// 	e.request._request._session.cannotFree,
				// 	e.request._request._session[http2.kCurrentStreamsCount],
				// 	e.request._request.state.localClose,
				// 	e.request._request.state.remoteClose,
				// 	JSON.stringify(e.request._request.state),
				// 	e.stack
				// );
				const request = e.request._request;
				console.error(e.message, request.aborted, request.ended, request.success);
                errors.add(e.message);
                fail++;
            };
		}));

        const request_time = Date.now() - time;
        const request_per_second = success / request_time;
        const ms_per_request = request_time / success;
        const rs = { name, n, request_time, success, fail, request_per_second, ms_per_request };
        console.table(rs);
        errors.size > 0 && console.error(errors.values());
        result.push(rs);
    }

    for (let i = 1, n = 1000; i <= 10; i++) {
        console.log(`==> Test with ${n} concurrent request`)
		await test('HTTP2', n, sendRequest);
    }

	console.table(result);
})();
