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

- **Agent** — send a message to an existing Agent (by ID) or to a temporary, inline-configured Agent, and get its reply. Supports multi-turn conversations (via *Previous Messages*), file attachments, tool-step limits and structured (JSON schema / enum) output.
- **Chat Completion** — OpenAI-compatible chat completions across all providers Langdock exposes (OpenAI, Anthropic, Mistral, Google). Use plain model IDs such as `gpt-4o`, `claude-sonnet-4-5` or `gemini-2.5-pro`.
- **Embedding** — create text embeddings via the OpenAI-compatible embeddings endpoint.

Each resource has an **Input Mode**:

- *Simple* — type a single message (and, for Chat Completion, an optional system message).
- *JSON* — supply the full `messages` array yourself for complex/multi-turn requests.

Toggle **Simplify Output** to get just the reply text / embedding vectors back instead of the raw API response.

## Compatibility

Built against `n8n-workflow` with the programmatic node API (`n8nNodesApiVersion: 1`). Tested with n8n 1.7x+.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Langdock API documentation](https://docs.langdock.com/en/developer/overview/api-introduction)
- [Langdock Agents Completions API](https://docs.langdock.com/en/developer/agents-api/agent)
- [Langdock OpenAI-compatible Chat Completion](https://docs.langdock.com/en/developer/completion-api/openai)
- [Langdock Embeddings API](https://docs.langdock.com/en/developer/embedding-api/openai-embedding)
