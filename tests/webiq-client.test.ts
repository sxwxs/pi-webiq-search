import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import {
	DEFAULT_ENDPOINT,
	DEFAULT_MAX_RESULTS,
	DEFAULT_TIMEOUT_MS,
	errorMessage,
	formatResults,
	normalizeEndpoint,
	readConfig,
	search,
	type WebIQConfig,
} from "../src/webiq-client.ts";

async function withServer(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
	run: (endpoint: string) => Promise<void>,
): Promise<void> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind");
	try {
		await run(`http://127.0.0.1:${address.port}/v3/search/web`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

function configFor(endpoint: string, overrides: Partial<WebIQConfig> = {}): WebIQConfig {
	return { ...readConfig({ PI_WEBIQ_ENDPOINT: endpoint }), ...overrides };
}

test("defaults to the local ghc-api endpoint and needs no API key", () => {
	const config = readConfig({});
	assert.equal(config.endpoint, DEFAULT_ENDPOINT);
	assert.equal(config.apiKey, undefined);
	assert.equal(config.token, undefined);
	assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
	assert.equal(config.maxResults, DEFAULT_MAX_RESULTS);
	assert.equal(config.toolName, "web_search");
});

test("a bare base URL gets the search path appended", () => {
	assert.equal(normalizeEndpoint("http://127.0.0.1:8313"), "http://127.0.0.1:8313/v3/search/web");
	assert.equal(normalizeEndpoint("https://api.microsoft.ai/"), "https://api.microsoft.ai/v3/search/web");
	assert.equal(normalizeEndpoint("https://host/v3/search/web"), "https://host/v3/search/web");
});

test("invalid configuration is rejected loudly", () => {
	assert.throws(() => normalizeEndpoint("not a url"), /Invalid PI_WEBIQ_ENDPOINT/);
	assert.throws(() => normalizeEndpoint("ftp://host/path"), /http:\/\/ or https:\/\//);
	assert.throws(() => readConfig({ PI_WEBIQ_TOOL_NAME: "bad name" }), /Invalid PI_WEBIQ_TOOL_NAME/);
});

test("environment overrides are read and clamped", () => {
	const config = readConfig({
		PI_WEBIQ_ENDPOINT: "https://api.microsoft.ai",
		PI_WEBIQ_API_KEY: " secret ",
		PI_WEBIQ_TOKEN: "user-token",
		PI_WEBIQ_MAX_RESULTS: "99",
		PI_WEBIQ_TIMEOUT_MS: "1",
		PI_WEBIQ_TOOL_NAME: "webiq_search",
	});
	assert.equal(config.endpoint, "https://api.microsoft.ai/v3/search/web");
	assert.equal(config.apiKey, "secret");
	assert.equal(config.token, "user-token");
	assert.equal(config.maxResults, 10);
	assert.equal(config.timeoutMs, 1_000);
	assert.equal(config.toolName, "webiq_search");
});

test("sends the official Web Search v3 request and normalizes webResults", async () => {
	await withServer(
		async (request, response) => {
			assert.equal(request.method, "POST");
			assert.equal(request.url, "/v3/search/web");
			assert.equal(request.headers["x-apikey"], undefined);
			let body = "";
			for await (const chunk of request) body += chunk;
			assert.deepEqual(JSON.parse(body), {
				query: "latest python release",
				maxResults: 2,
				contentFormat: "passage",
				maxLength: 3000,
			});
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					webResults: [
						{ title: "Python", url: "https://python.org", content: "3.14.7", lastUpdatedAt: "2026-08-05" },
						{ url: "https://example.com", content: 42 },
						{ title: "dropped by maxResults", url: "https://ignored.example" },
					],
					traceId: "trace-1",
				}),
			);
		},
		async (endpoint) => {
			const result = await search(" latest python release ", configFor(endpoint), { maxResults: 2 });
			assert.equal(result.query, "latest python release");
			assert.equal(result.traceId, "trace-1");
			assert.deepEqual(result.results, [
				{ title: "Python", url: "https://python.org", content: "3.14.7", lastUpdatedAt: "2026-08-05" },
				{ title: "https://example.com", url: "https://example.com", content: "42" },
			]);
		},
	);
});

test("forwards an API key and a bearer token when configured", async () => {
	await withServer(
		(request, response) => {
			assert.equal(request.headers["x-apikey"], "key-1");
			assert.equal(request.headers.authorization, "Bearer token-1");
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ webResults: [] }));
		},
		async (endpoint) => {
			const config = configFor(endpoint, { apiKey: "key-1", token: "token-1" });
			assert.deepEqual((await search("q", config)).results, []);
		},
	);
});

test("surfaces the Web IQ error envelope", async () => {
	await withServer(
		(request, response) => {
			response.statusCode = 400;
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					errorCode: "HandlerInvalidInput",
					userMessage: "Invalid input provided.",
					technicalDetails: "query is required",
				}),
			);
		},
		async (endpoint) => {
			await assert.rejects(
				search("q", configFor(endpoint)),
				/HTTP 400.*Invalid input provided\. - query is required/s,
			);
		},
	);
});

test("surfaces the ghc-api error envelope", async () => {
	await withServer(
		(request, response) => {
			response.statusCode = 503;
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ error: { message: "Web IQ is not configured on this server." } }));
		},
		async (endpoint) => {
			await assert.rejects(search("q", configFor(endpoint)), /HTTP 503.*not configured/s);
		},
	);
});

test("rejects a payload without webResults", async () => {
	await withServer(
		(request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ results: [] }));
		},
		async (endpoint) => {
			await assert.rejects(search("q", configFor(endpoint)), /no webResults array/);
		},
	);
});

test("an unreachable endpoint names the endpoint", async () => {
	const config = configFor("http://127.0.0.1:1/v3/search/web");
	await assert.rejects(search("q", config), /could not reach http:\/\/127\.0\.0\.1:1/);
});

test("an empty query never reaches the network", async () => {
	await assert.rejects(search("   ", configFor("http://127.0.0.1:1")), /non-empty query/);
});

test("formatting keeps titles and URLs and caps the output size", () => {
	const output = formatResults({
		query: "q",
		elapsedMs: 5,
		results: [
			{ title: "T1", url: "https://a.example", content: "x".repeat(5_000) },
			{ title: "T2", url: "https://b.example", content: "y".repeat(5_000) },
		],
	});
	assert.match(output, /Untrusted web content/);
	assert.match(output, /\[1\] T1\nhttps:\/\/a\.example/);
	assert.match(output, /\[2\] T2\nhttps:\/\/b\.example/);

	const capped = formatResults(
		{
			query: "q",
			elapsedMs: 5,
			results: [{ title: "T1", url: "https://a.example", content: "x".repeat(50_000) }],
		},
		2_000,
	);
	assert.ok(new TextEncoder().encode(capped).byteLength <= 2_000);
	assert.match(capped, /output truncated/);
});

test("no results is reported as data, not as an error", () => {
	assert.match(formatResults({ query: "nothing", elapsedMs: 1, results: [] }), /No web results for "nothing"/);
});

test("errorMessage falls back to the raw body and status", () => {
	assert.equal(errorMessage(undefined, "boom", 500), "boom");
	assert.equal(errorMessage({}, "", 500), "HTTP 500");
	assert.equal(errorMessage({ error: "nope" }, "", 500), "nope");
});
