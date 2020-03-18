'use strict';
const net = require('net');
const http2 = require('http2');
const util = require('util');
const lolex = require('lolex');

const key = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAy9mQETCpkxAp2K2kj9l9+LA5apVeKnY+7TQDTE9qpJWNUqmh
ZzwGXsDWNd16eLfUFp9R6G79IHI6A9xeOI74SWE/DQQanBxewMUSV1wZBvl+fWy6
qgLOkNAk8CMuIC99ENnuk5Y0ag8ySS2tHn9QQ/cbnHaas3mN9VzxQKe0Iw1hrrn6
NSn9CsBHWKGCU7Hch/gVPQbxfNUxrJeyGuM6j0Mbhl1hYQLC3YLRqn8Aun/mdDfg
ZgX8+Dbl792bC2vTYS3M+iV3BcQveAL8UY0Ky51++hxOk9LLqhDmxZBC2ldx702X
FhMtVf23oxfOWj6WEJm5i+22xB72wFjXXu3KBwIDAQABAoIBAGorTOp3Esqib3kH
rx6wovhkJ/NICjxJS6rVHSagciV4Mpur94FB9Ptiqe5yBLhc3dxObCWHsNQ2Sdr6
6iPA6rWlLWaFDari58K0oUHYmLxWMzf16h5jydwIXESpvftLYHLnXmeFopTeh00v
ueuZWV+cksfhyd7R30q8dnY7Igninv8mEH3Hyv4lQQ5Pa2TyQv5o1cWGoAoNM/DV
NVGK1+VSb+pOlXHic0CdRFNC1ujQL5PUjSs87pxQ872T1r/+ysd+v/bszt7dMl3T
n6EfFbe6uT+jF+JGCIkGrsFem3DP9SJsj0DiWoBMM1gM4ItAsE9s86bvgCDi2B10
wFYnPJkCgYEA8Tixjwazj8i3CyfHQJy9W61IGUMUGyzq5YlpA8y88IBPsOR+3OEg
bc37PtBc+vvJq14ZnsG9buj4nTAc169pWqFeA8rCTrK5G9bz5capIwia6kmE4SRP
+ozkk40JRCgbtuwcIaEVDRoUTjaREfnYskV/EBi7SYIKkt5pyUpOqZMCgYEA2Fa8
EClptVd0Vav+IbtK70PqLQ3buaY5aIKLbuLzJoeBKJxvd0Im3AJNlWIV4tPFdeT0
STfoFxGrSjFMvApjyWzm4fXVXsMrOk6M+xoIAwp5l5byOhoywzNsmjN8C9VM+Tzb
JoAabaUYU9RPh+XHDnm2HYeLJQl6D6eL9zDoVj0CgYB+f3ydxKXlgRx8fR/AgnHK
4dQtaz/gAG4ucSDhHTz34lHoMetVabnX220mQ55/AAuCEpbc6jytLP8zb0ew1Awr
uvPSiUHcg10PfGnq1YNdG+Yhdux4JNLMUZaMyilR1Laz9p3KBO9FL6f2XCc3hg5d
bpRznISax9dDrd9L7+vQgQKBgQCMup9LxCTHmkRLFr8SIkv0qTFEbadpdQATRBh/
4ZJalfsm99xqr9WneLgPXObvzuK8dluS5ZNMrmnGsZtBF2EiPn1SsCBErKEKJN8A
2UYs9Dt0qPSZZ0FuSZ10Edm3uOGBoFzPBrYqbSMOJSY3OPnsKLCXNP0G8ss8M7mQ
63e34QKBgQC9oswXltDEtFV2ubpU10KInYnxTBR1gFN8msopXPyR8su2wIAXnDfk
EbCthNKSqMJqxhY+bZAdmHp0La6FRtdIProXq/Dw2jKy1sa+9HnznbGUu0d3aXb+
YCqSn7U4EloIe9FFxPH/I5tp29IsuUAkLAVnxU1Kpu1GwGrFX11Ggw==
-----END RSA PRIVATE KEY-----`;

const cert = `-----BEGIN CERTIFICATE-----
MIICpjCCAY4CCQCZsDhoApABCDANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwHhcNMjAwMzE4MTQwMTQwWhcNMjEwMzE4MTQwMTQwWjAWMRQwEgYD
VQQDDAtleGFtcGxlLmNvbTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AMvZkBEwqZMQKditpI/ZffiwOWqVXip2Pu00A0xPaqSVjVKpoWc8Bl7A1jXdeni3
1BafUehu/SByOgPcXjiO+ElhPw0EGpwcXsDFEldcGQb5fn1suqoCzpDQJPAjLiAv
fRDZ7pOWNGoPMkktrR5/UEP3G5x2mrN5jfVc8UCntCMNYa65+jUp/QrAR1ihglOx
3If4FT0G8XzVMayXshrjOo9DG4ZdYWECwt2C0ap/ALp/5nQ34GYF/Pg25e/dmwtr
02EtzPoldwXEL3gC/FGNCsudfvocTpPSy6oQ5sWQQtpXce9NlxYTLVX9t6MXzlo+
lhCZuYvttsQe9sBY117tygcCAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAQmX0/xNS
G0z2kryeXBDZJQqop65sqDjcK4JaC98XXHKGU3z+1pFMcbm19PwpiY6TQeBP/sqk
L/MooPx0u54DAv0JkdaZffeuoj95tNcIzKRxUzVlVgtc0xW0IGex9s1lgN15akA1
ELyaQaqx5DnM+C9lkY8S3bKpe6Y4ffUe7FXQ8TBZO19E5cmzHppSXkf/znEHL1n6
gbi5uNRyVtBGmhqdd5vbjTbTbIDE4PiDVs0senOPQMxbXjWBRZlKd4YoXZCCwM8T
L4D2EjUeWMWY2WYQ240s1x/luy4uQ8KwUwnWmjT2XQSTb79wkop4Qjur1LFclWOs
fQ/iyWOVfEchWA==
-----END CERTIFICATE-----`;

const createPlainServer = async (options, handler) => {
	if (typeof options === 'function') {
		handler = options;
	}

	const server = http2.createSecureServer({cert, key, allowHTTP1: true, ...options}, handler);

	server.listen = util.promisify(server.listen);
	server.close = util.promisify(server.close);

	server.options = {
		hostname: 'localhost',
		protocol: 'https:'
	};

	server.once('listening', () => {
		server.options.port = server.address().port;
		server.url = `${server.options.protocol}//${server.options.hostname}:${server.options.port}`;
	});

	return server;
};

const createProxyServer = async options => {
	const proxy = await createPlainServer(options);

	proxy.on('stream', (stream, headers) => {
		if (headers[':method'] !== 'CONNECT') {
			// Only accept CONNECT requests
			stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
			return;
		}

		const auth = new URL(`tcp://${headers[':authority']}`);
		const socket = net.connect(auth.port, auth.hostname, () => {
			stream.respond();
			socket.pipe(stream);
			stream.pipe(socket);
		});

		socket.on('error', () => {
			stream.close(http2.constants.NGHTTP2_CONNECT_ERROR);
		});
	});

	return proxy;
};

const createServer = async options => {
	const onRequest = (request, response) => {
		const body = [];

		request.on('data', chunk => body.push(chunk));
		request.on('end', () => {
			response.end(JSON.stringify({
				headers: request.headers,
				body: Buffer.concat(body).toString()
			}));
		});
	};

	const handlers = {
		get: {
			'/': onRequest
		},
		post: {
			'/': onRequest
		}
	};

	const server = await createPlainServer(options, (request, response) => {
		const methodHandlers = handlers[request.method.toLowerCase()];
		if (methodHandlers && methodHandlers[request.url]) {
			return methodHandlers[request.url](request, response);
		}
	});

	for (const method of Object.keys(handlers)) {
		server[method] = (path, fn) => {
			handlers[method][path] = fn;
		};
	}

	return server;
};

const createPlainWrapper = options => {
	return async (t, run) => {
		const create = (options && options.createServer) || createServer;

		const clock = options && options.lolex ? lolex.install() : lolex.createClock();

		const server = await create(options);
		await server.listen();

		// Useful to fix uncaught exceptions:
		// console.log(`${server.options.port} - ${t.title}`);

		try {
			await run(t, server, clock);
		} finally {
			if (options && options.beforeServerClose) {
				options.beforeServerClose();
			}

			clock.runAll();

			if (options && options.lolex) {
				clock.uninstall();
			}

			await server.close();
		}
	};
};

const createWrapper = options => {
	const wrapper = createPlainWrapper(options);
	wrapper.lolex = createPlainWrapper({...options, lolex: true});

	return wrapper;
};

module.exports = {createServer, createProxyServer, createWrapper};
