# n8n-nodes-langdock

This is an n8n community node. It lets you use [Langdock](https://langdock.com) in your n8n workflows.

Langdock is an enterprise AI platform that provides API access to LLMs (OpenAI, Anthropic, Mistral, Google), custom Agents, and embeddings with enterprise-grade security and GDPR compliance.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

[Installation](#installation)
[Credentials](#credentials)
[Operations](#operations)
[Compatibility](#compatibility)
[Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

In n8n: **Settings → Community Nodes → Install**, then enter `n8n-nodes-langdock`.

## Credentials

You need a Langdock API key.

1. In Langdock, go to **Settings → API Keys** and create a personal or workspace API key. Workspace keys let you scope permissions (e.g. `AGENT_API`) per key.
2. In n8n, create a **Langdock API** credential and paste the key.
3. Choose **Langdock Cloud** (with the correct **Region**, `eu` or `us`) or **Dedicated Deployment** (with your deployment's base URL, e.g. `https://your-domain.example.com/api/public`) depending on your setup.

Requests are only allowed from a backend context — the Langdock API blocks calls made directly from a browser to protect your key.

## Operations

The **Langdock** node supports three resources:

- **Agent** — send a message to an existing Agent (by ID) or to a temporary, inline-configured Agent, and get its reply. Supports multi-turn conversations (via *Previous Messages*), file attachments, tool-step limits, web search, streaming, and structured (JSON schema / enum) output. This is the only resource with access to non-OpenAI models (Anthropic, Google, ...), since Langdock routes the Agent API to whichever provider the selected model belongs to.
- **Chat Completion** — calls Langdock's OpenAI-compatible completion endpoint (`/openai/{region}/v1/chat/completions`). This endpoint is **OpenAI-only**: the Model dropdown only lists OpenAI models. Claude and other providers are exposed through separate, differently-shaped Langdock endpoints and are not wired into this resource — use **Agent** (Temporary Agent) instead if you need a non-OpenAI model.
- **Embedding** — create text embeddings via the OpenAI-compatible embeddings endpoint.

Model fields are dropdowns loaded live from Langdock (`/agent/v1/models` for Agent, `/openai/{region}/v1/models` for Chat Completion and Embedding) — use the list, or click the expression icon to supply a model ID dynamically.

Each resource has an **Input Mode**:

- *Simple* — type a single message (and, for Chat Completion, an optional system message).
- *JSON* — supply the full `messages` array yourself for complex/multi-turn requests.

Toggle **Simplify Output** to get just the reply text / embedding vectors back instead of the raw API response.

### Web Search (Agent only)

When **Agent Source** is **Temporary Agent (Inline Configuration)**, an additional **Web Search** toggle appears. When enabled, the request sends `agent.capabilities.webSearch: true`, letting the temporary Agent search the web before answering. It only applies to inline agents — an existing Agent's capabilities are configured in Langdock itself, not from this node. Left off (default), no `capabilities` object is sent at all.

### Output Format (Agent & Chat Completion)

**Output Format** (`Text` / `JSON`, default `Text`) controls whether the model is asked to return free-form text or a technically-enforced JSON response:

- **Text** — unchanged, existing behaviour. The reply comes back as plain text in `reply`.
- **JSON**:
  - **Agent** — sends `output.type: "object"`, unless you've already picked **Array** or **Enum** under *Additional Fields → Structured Output Type* (that explicit choice always wins). You can still attach an *Output JSON Schema* in *Additional Fields*, with or without a Structured Output Type set.
  - **Chat Completion** — sends the OpenAI-compatible `response_format: { type: "json_object" }`. Only works with models that support it; unsupported models will return an API error. With **Simplify Output** on, the node tries to `JSON.parse` the model's reply and returns it as an object; if parsing fails (the model didn't return valid JSON), the raw string is returned instead.

Workflows built before this option was added are unaffected — they keep running with `Output Format = Text`.

### Timeout (Seconds)

**Timeout (Seconds)** (default `300`, range `1`–`900`) sets how long the node waits for a Langdock API response, for Agent, Chat Completion and Embedding requests. It is **not** sent to the model-list dropdowns.

Note that Langdock's own non-streaming request handling may enforce a shorter server-side limit — around 100 seconds for the Agent Completions endpoint — regardless of this setting. Raising Timeout (Seconds) beyond that only helps if the bottleneck is network/n8n-side; it does not change what Langdock itself allows server-side. For long-running Agent tasks (e.g. web research), enable **Stream Response** (below) instead of relying purely on a longer client timeout.

**Timeout semantics**: Timeout (Seconds) is a **total-duration deadline**, not a per-chunk/idle timeout. For a streamed request it is measured once, from the moment the node starts reading the response, and covers the entire stream regardless of how many chunks arrive or how long the gaps between them are — a slow-but-steadily-streaming response is not killed just because an individual chunk took a while, only the overall deadline is enforced. When it's hit, the node closes the connection and reports a timeout error (for a non-streaming request, the same field is simply passed as the HTTP client's request timeout).

### Streaming (Agent only)

Enable **Stream Response** (under Resource = Agent) to send `stream: true` to Langdock's Agent Completions endpoint (`POST /agent/v1/chat/completions`) and read the reply incrementally as Langdock sends it, instead of waiting for one buffered response. This works with both **Existing Agent (by ID)** and **Temporary Agent (Inline Configuration)**, and combines with Web Search, Output Format and Structured Output exactly as described above. It does **not** apply to Chat Completion or Embedding — Chat Completion's `/openai/{region}/...` endpoint uses a different (OpenAI-style) streaming wire format that this node does not implement, and Embedding responses are never streamed.

Why this exists: a long web-research Agent call can run past the ~100 second non-streaming limit and gets killed with an HTTP 524 (Cloudflare: origin didn't respond in time) before Langdock ever gets to send a result. Streaming keeps the HTTP connection open for as long as Langdock keeps sending SSE chunks on it, which is generally more resilient to that specific failure mode.

**This is not a guarantee against 524s.** Streaming only helps because Cloudflare (and most reverse proxies) reset their idle/response timers on each byte received — it still requires Langdock to keep sending *something* (even a keepalive) at reasonable intervals. If Langdock's own backend stalls without emitting any chunk for longer than the proxy's timeout, or drops the connection outright, you can still get an abrupt disconnect or a 524, now surfaced by this node as "the Langdock stream ended before a finish/[DONE] signal was received" or "Langdock stream connection error" rather than a plain 524.

**Output while streaming** (mirrors the non-streaming shapes described above, additively):

- `Simplify Output = true`, `Output Format = Text` → `{ "reply": "<assembled text>" }`
- `Simplify Output = true`, `Output Format = JSON` → `{ "reply": "<assembled text>", "output": {...} }` — `output` comes from an explicit structured-output chunk if Langdock sends one, otherwise the node `JSON.parse`s the fully assembled text once the stream completes. If that still isn't valid JSON, the node throws a clear error rather than returning broken/partial JSON — structured output is only ever validated after the stream has fully finished, never on partial chunks.
- `Simplify Output = false` → `{ "messages": [{ "id": ..., "role": "assistant", "content": "<assembled text>" }], "output"?: {...}, "sources"?: [...], "toolCalls"?: [...] }`. `messages`/`output` match the non-streaming response shape; `sources` (from `source-url`/`source-document` chunks) and `toolCalls` (from `tool-*` chunks) are additive streaming-only fields, only present when Langdock actually sent that kind of chunk.

### Retry on Transient Errors (Agent only)

Under Agent → *Additional Fields*:

- **Retry Transient Errors** (default off) — when enabled, automatically retries a failed request for that item.
- **Max Retries** (default `3`, `0`–`10`) — additional attempts after the first failure.
- **Retry Delay (Seconds)** (default `15`, `0`–`120`) — initial backoff delay; each subsequent retry doubles it, capped at 120 seconds, plus a little jitter. If Langdock's response includes a `Retry-After` header, that value is used instead when it's longer.

A failure is only retried when it looks transient: HTTP `408`, `429`, `502`, `503`, `504` or `524` (Cloudflare gateway timeout), or one of this node's own "stream never completed" errors (see [Streaming](#streaming-agent-only) above). A cancelled execution and an explicit API error chunk are never retried, even though they can otherwise look similar. Retries happen per item and are transparent to downstream nodes on success — they only become visible if every attempt fails.

With **Continue On Fail** enabled on the node, every error item (for any resource) now includes retry diagnostics alongside the usual `error` message: `langdockError: true`, `statusCode` (if one could be determined), `attempts`, and `retryable`. For Chat Completion and Embedding — which have no retry option and are never retried — `attempts` is simply `1`; `retryable` reflects whether the failure *would* have been considered transient. The existing `error` field's value is unchanged, so workflows built before this option was added keep working.

### Example: company research agent

A temporary Agent with web search, JSON output and a longer timeout, useful for structured company lookups:

- **Resource**: Agent
- **Agent Source**: Temporary Agent (Inline Configuration)
- **Agent Name**: `Company Research`
- **Instructions**: `Research the given company and summarize: legal name, industry, headquarters, employee count estimate, and one recent news item. Only state facts you found via search.`
- **Model**: any web-search-capable model, e.g. `gpt-4o`
- **Web Search**: enabled
- **Message Text**: `={{ $json.companyName }}`
- **Output Format**: JSON
- **Additional Fields → Output JSON Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "legalName": { "type": "string" },
      "industry": { "type": "string" },
      "headquarters": { "type": "string" },
      "employeeEstimate": { "type": "string" },
      "recentNews": { "type": "string" }
    },
    "required": ["legalName", "industry"]
  }
  ```
- **Timeout (Seconds)**: `120` (web search + reasoning can take longer than the default single-turn case)
- **Stream Response**: enabled, if research regularly takes long enough to risk a 524 (see [Streaming](#streaming-agent-only) above)

## Compatibility

Built against `n8n-workflow` with the programmatic node API (`n8nNodesApiVersion: 1`). Tested with n8n 1.7x+.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Langdock API documentation](https://docs.langdock.com/en/developer/overview/api-introduction)
- [Langdock Agents Completions API](https://docs.langdock.com/en/developer/agents-api/agent)
- [Langdock OpenAI-compatible Chat Completion](https://docs.langdock.com/en/developer/completion-api/openai)
- [Langdock Embeddings API](https://docs.langdock.com/en/developer/embedding-api/openai-embedding)
