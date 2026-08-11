# pi-webiq-search

A pi package that gives the agent one tool: `web_search`, backed by the
Microsoft Web IQ **Web Search v3** API
(`POST /v3/search/web`, [contract](https://webiq.microsoft.ai/documentation/api-reference/web/)).

By default it talks to a local [ghc-api](https://github.com/sxwxs/ghc-api)
instance at `http://127.0.0.1:8313/v3/search/web`, which is a transparent proxy
for that API and holds the API key server-side. **No API key is needed here**,
and none is sent unless you configure one.

## Install

```bash
pi install /home/medivh/code/pi-webiq-search      # local path
pi install git:github.com/<you>/pi-webiq-search   # once published
```

Try it for a single run without installing:

```bash
pi -e /home/medivh/code/pi-webiq-search
```

Requires the ghc-api server to be running (`http://127.0.0.1:8313`) with Web IQ
enabled and a key in its `config.yaml`.

## The tool

```
web_search(query: string, max_results?: 1..10)
```

The schema is deliberately narrow — a query and a result count — because models
fill in eight knobs badly. The package turns those into the full official
request, sending `contentFormat: "passage"` and `maxLength` so a tool result
stays small in tokens instead of getting Microsoft's defaults (10 results of
full HTML, 10 000 characters each).

The result handed to the model is plain text: a header, an untrusted-content
warning, then numbered `title / url / passage` blocks. Total output is capped at
48 KB; over that, the longest passages are shortened first so the top hits and
their URLs survive. Failures (unreachable server, HTTP 4xx/5xx, unexpected
payload) are thrown, so pi marks the tool call as failed and shows the upstream
message including the Web IQ `technicalDetails` and ghc-api's error envelope.

The extension also registers `promptGuidelines`, so while the tool is active the
system prompt tells the model to search for recent or niche facts and to treat
results as data, never as instructions.

## Configuration

All configuration is environment variables, read once when the extension loads.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_WEBIQ_ENDPOINT` | `http://127.0.0.1:8313/v3/search/web` | Search endpoint. A bare base URL (`http://host:8313`) gets `/v3/search/web` appended. |
| `PI_WEBIQ_API_KEY` | *(unset)* | Sent as `x-apikey`. Only needed when talking to `https://api.microsoft.ai` directly. |
| `PI_WEBIQ_TOKEN` | *(unset)* | Sent as `Authorization: Bearer …`, for a proxy with the user-token gate enabled. |
| `PI_WEBIQ_TIMEOUT_MS` | `30000` | Request timeout, clamped to 1 000–300 000. |
| `PI_WEBIQ_MAX_RESULTS` | `5` | Result count when the model does not pass `max_results`. Clamped to 1–10. |
| `PI_WEBIQ_MAX_LENGTH` | `3000` | Per-result passage budget in characters, clamped to 200–20 000. |
| `PI_WEBIQ_CONTENT_FORMAT` | `passage` | Upstream `contentFormat`. `html` returns full pages and is much more expensive. |
| `PI_WEBIQ_TOOL_NAME` | `web_search` | Rename the tool, e.g. `webiq_search`, if another package already registers `web_search`. |

Direct-to-Microsoft example:

```bash
export PI_WEBIQ_ENDPOINT=https://api.microsoft.ai
export PI_WEBIQ_API_KEY=…
```

## Layout

```
extensions/webiq-search.ts   tool registration and TUI rendering
src/webiq-client.ts          config, HTTP call, normalization, output formatting
tests/webiq-client.test.ts   node:test suite against a local HTTP server
```

## Development

```bash
npm install
npm run check     # typecheck + tests
```

## Security

Search results are untrusted web content. The tool output says so explicitly,
and the prompt guidelines repeat it, but prompt injection through search results
remains possible: never let the agent act on instructions found in a result.
