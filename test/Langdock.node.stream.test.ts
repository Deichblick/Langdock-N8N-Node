import { PassThrough } from 'stream';
import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { Langdock } from '../nodes/Langdock/Langdock.node';

function sse(obj: unknown): string {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

function createContext(config: {
	params: Record<string, unknown>;
	items?: IDataObject[];
	credentials?: IDataObject;
	httpImpl: jest.Mock;
	continueOnFail?: boolean;
	cancelSignal?: AbortSignal;
}): IExecuteFunctions {
	const {
		params,
		items = [{ json: {} }],
		credentials = { environment: 'cloud', region: 'eu', apiKey: 'test-key-not-real' },
		httpImpl,
		continueOnFail = false,
		cancelSignal,
	} = config;

	return {
		getInputData: () => items,
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		getCredentials: async () => credentials,
		getNode: () => ({ name: 'Langdock', type: 'langdock' }),
		continueOnFail: () => continueOnFail,
		getExecutionCancelSignal: () => cancelSignal,
		helpers: {
			httpRequestWithAuthentication: httpImpl,
		},
	} as unknown as IExecuteFunctions;
}

/** A jest.fn() that, on every call, resolves with a fresh PassThrough (as
 * IN8nHttpFullResponse.body) pre-loaded with the given SSE text, written on
 * a microtask so consumeLangdockStream has already attached its listeners. */
function mockStreamingHttpImpl(sseText: string | string[]) {
	const texts = Array.isArray(sseText) ? sseText : [sseText];
	let call = 0;

	return jest.fn().mockImplementation(async () => {
		const text = texts[Math.min(call, texts.length - 1)];
		call += 1;
		const stream = new PassThrough();
		queueMicrotask(() => {
			stream.write(text);
			stream.end();
		});
		return { body: stream, headers: {}, statusCode: 200 };
	});
}

function streamAgentParams(overrides: Record<string, unknown> = {}) {
	return {
		resource: 'agent',
		agentSource: 'inline',
		agentName: 'Test Agent',
		agentInstructions: 'Be helpful',
		agentModel: 'gpt-4o',
		agentTemperature: 0.7,
		webSearch: false,
		streamResponse: true,
		inputMode: 'simple',
		messageText: 'Hello',
		additionalFields: {},
		simplifyOutput: true,
		outputFormat: 'text',
		...overrides,
	};
}

describe('Langdock node - streaming', () => {
	let node: Langdock;

	beforeEach(() => {
		node = new Langdock();
	});

	// 1. Stream Response = false -> unchanged, no `stream` field sent
	it('does not add a stream field to the request when Stream Response is off', async () => {
		const httpImpl = jest.fn().mockResolvedValue({ messages: [{ id: '1', role: 'assistant', content: 'Hi' }] });
		const ctx = createContext({ params: streamAgentParams({ streamResponse: false }), httpImpl });

		await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		expect(body.stream).toBeUndefined();
		expect(httpImpl.mock.calls[0][1].encoding).toBeUndefined();
	});

	// 2. Stream Response = true -> request contains stream: true and asks for a raw stream
	it('requests stream: true and encoding: stream when Stream Response is on', async () => {
		const httpImpl = mockStreamingHttpImpl(sse({ type: 'text-delta', delta: 'Hi' }) + DONE);
		const ctx = createContext({ params: streamAgentParams(), httpImpl });

		await node.execute.call(ctx);

		const callOptions = httpImpl.mock.calls[0][1];
		expect((callOptions.body as IDataObject).stream).toBe(true);
		expect(callOptions.encoding).toBe('stream');
		expect(callOptions.returnFullResponse).toBe(true);
	});

	// 16 + 18: Simplify Output = true, Output Format = Text
	it('returns { reply } for a simplified, text-mode streamed response', async () => {
		const httpImpl = mockStreamingHttpImpl(
			sse({ type: 'text-delta', delta: 'Hello ' }) + sse({ type: 'text-delta', delta: 'World' }) + DONE,
		);
		const ctx = createContext({ params: streamAgentParams({ outputFormat: 'text' }), httpImpl });

		const result = await node.execute.call(ctx);

		expect(result[0][0].json).toEqual({ reply: 'Hello World' });
	});

	// 19: Output Format = JSON, structured output assembled from streamed text
	it('parses the assembled text as JSON when Output Format is JSON and no explicit output chunk arrived', async () => {
		const httpImpl = mockStreamingHttpImpl(
			sse({ type: 'text-delta', delta: '{"ok":' }) + sse({ type: 'text-delta', delta: 'true}' }) + DONE,
		);
		const ctx = createContext({ params: streamAgentParams({ outputFormat: 'json' }), httpImpl });

		const result = await node.execute.call(ctx);

		expect(result[0][0].json).toEqual({ reply: '{"ok":true}', output: { ok: true } });
	});

	it('throws a clear error when Output Format is JSON but the streamed text never became valid JSON', async () => {
		const httpImpl = mockStreamingHttpImpl(sse({ type: 'text-delta', delta: 'not json' }) + DONE);
		const ctx = createContext({ params: streamAgentParams({ outputFormat: 'json' }), httpImpl });

		await expect(node.execute.call(ctx)).rejects.toThrow(/did not contain valid JSON/);
	});

	// 17: Simplify Output = false -> compatible raw-ish shape
	it('returns an assembled messages/output/sources shape when Simplify Output is off', async () => {
		const httpImpl = mockStreamingHttpImpl(
			sse({ type: 'text-delta', delta: 'Hi' }) +
				sse({ type: 'source-url', url: 'https://example.com' }) +
				sse({ type: 'finish', output: { done: true } }),
		);
		const ctx = createContext({ params: streamAgentParams({ simplifyOutput: false }), httpImpl });

		const result = await node.execute.call(ctx);
		const json = result[0][0].json as IDataObject;

		expect((json.messages as IDataObject[])[0].content).toBe('Hi');
		expect(json.output).toEqual({ done: true });
		expect(json.sources).toEqual([{ type: 'source-url', url: 'https://example.com' }]);
	});

	// 20: Web Search = true combined with streaming
	it('sends capabilities.webSearch alongside stream: true', async () => {
		const httpImpl = mockStreamingHttpImpl(DONE);
		const ctx = createContext({ params: streamAgentParams({ webSearch: true }), httpImpl });

		await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		const agent = body.agent as IDataObject;
		expect(agent.capabilities).toEqual({ webSearch: true });
		expect(body.stream).toBe(true);
	});

	// 21: Web Search = false combined with streaming
	it('sends no capabilities object when Web Search is off, even while streaming', async () => {
		const httpImpl = mockStreamingHttpImpl(DONE);
		const ctx = createContext({ params: streamAgentParams({ webSearch: false }), httpImpl });

		await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		const agent = body.agent as IDataObject;
		expect(agent.capabilities).toBeUndefined();
	});

	// 22: multiple input items while streaming
	it('processes multiple items sequentially, each with its own stream', async () => {
		const httpImpl = mockStreamingHttpImpl([
			sse({ type: 'text-delta', delta: 'first' }) + DONE,
			sse({ type: 'text-delta', delta: 'second' }) + DONE,
		]);
		const ctx = createContext({
			params: streamAgentParams(),
			items: [{ json: {} }, { json: {} }],
			httpImpl,
		});

		const result = await node.execute.call(ctx);

		expect(httpImpl).toHaveBeenCalledTimes(2);
		expect(result[0][0].json).toEqual({ reply: 'first' });
		expect(result[0][1].json).toEqual({ reply: 'second' });
	});

	// 23: existing Agent by ID + streaming
	it('supports Stream Response with an existing Agent (by ID)', async () => {
		const httpImpl = mockStreamingHttpImpl(sse({ type: 'text-delta', delta: 'from existing agent' }) + DONE);
		const ctx = createContext({
			params: {
				resource: 'agent',
				agentSource: 'id',
				agentId: 'agent_123',
				streamResponse: true,
				inputMode: 'simple',
				messageText: 'Hello',
				additionalFields: {},
				simplifyOutput: true,
				outputFormat: 'text',
			},
			httpImpl,
		});

		const result = await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		expect(body.agentId).toBe('agent_123');
		expect(body.stream).toBe(true);
		expect(result[0][0].json).toEqual({ reply: 'from existing agent' });
	});

	// 11/12: initial HTTP error (524/429 style) while Stream Response is on -
	// these happen before a stream is ever obtained, so they are caught by the
	// same per-item error handling as the non-streaming path.
	it('propagates a 524-style initial HTTP error the same way as non-streaming requests', async () => {
		const httpImpl = jest.fn().mockRejectedValue(new Error('Request failed with status code 524'));
		const ctx = createContext({
			params: streamAgentParams(),
			httpImpl,
			continueOnFail: true,
		});

		const result = await node.execute.call(ctx);
		expect(result[0][0].json.error).toBe('Request failed with status code 524');
	});

	it('propagates a 429-style initial HTTP error the same way as non-streaming requests', async () => {
		const httpImpl = jest.fn().mockRejectedValue(new Error('Request failed with status code 429'));
		const ctx = createContext({
			params: streamAgentParams(),
			httpImpl,
			continueOnFail: true,
		});

		const result = await node.execute.call(ctx);
		expect(result[0][0].json.error).toBe('Request failed with status code 429');
	});

	// 15: user cancellation surfaced through the full execute() path
	it('surfaces execution cancellation raised while reading the stream', async () => {
		const controller = new AbortController();
		const stream = new PassThrough();
		const httpImpl = jest.fn().mockResolvedValue({ body: stream, headers: {}, statusCode: 200 });
		const ctx = createContext({
			params: streamAgentParams(),
			httpImpl,
			cancelSignal: controller.signal,
			continueOnFail: true,
		});

		const resultPromise = node.execute.call(ctx);
		queueMicrotask(() => controller.abort());

		const result = await resultPromise;
		expect(String(result[0][0].json.error)).toMatch(/cancelled/);
	});
});
