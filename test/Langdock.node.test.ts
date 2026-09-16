import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { Langdock } from '../nodes/Langdock/Langdock.node';

/**
 * Minimal fake IExecuteFunctions context. No real HTTP calls are ever made -
 * `httpImpl` fully replaces `helpers.httpRequestWithAuthentication`.
 */
function createContext(config: {
	params: Record<string, unknown>;
	items?: IDataObject[];
	credentials?: IDataObject;
	httpImpl: jest.Mock;
	continueOnFail?: boolean;
}): IExecuteFunctions {
	const {
		params,
		items = [{ json: {} }],
		credentials = { environment: 'cloud', region: 'eu', apiKey: 'test-key-not-real' },
		httpImpl,
		continueOnFail = false,
	} = config;

	return {
		getInputData: () => items,
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		getCredentials: async () => credentials,
		getNode: () => ({ name: 'Langdock', type: 'langdock' }),
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: httpImpl,
		},
	} as unknown as IExecuteFunctions;
}

function agentInlineParams(overrides: Record<string, unknown> = {}) {
	return {
		resource: 'agent',
		agentSource: 'inline',
		agentName: 'Test Agent',
		agentInstructions: 'Be helpful',
		agentModel: 'gpt-4o',
		agentTemperature: 0.7,
		inputMode: 'simple',
		messageText: 'Hello',
		additionalFields: {},
		simplifyOutput: true,
		...overrides,
	};
}

const agentApiResponse = {
	messages: [{ id: '2', role: 'assistant', content: 'Hi there' }],
};

describe('Langdock node', () => {
	let node: Langdock;

	beforeEach(() => {
		node = new Langdock();
	});

	// 1. Inline Agent without Web Search
	it('does not send a capabilities object when Web Search is off', async () => {
		const httpImpl = jest.fn().mockResolvedValue(agentApiResponse);
		const ctx = createContext({ params: agentInlineParams({ webSearch: false }), httpImpl });

		await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		const agent = body.agent as IDataObject;
		expect(agent.capabilities).toBeUndefined();
	});

	// 2. Inline Agent with capabilities.webSearch = true
	it('sends capabilities.webSearch: true when Web Search is on', async () => {
		const httpImpl = jest.fn().mockResolvedValue(agentApiResponse);
		const ctx = createContext({ params: agentInlineParams({ webSearch: true }), httpImpl });

		await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		const agent = body.agent as IDataObject;
		expect(agent.capabilities).toEqual({ webSearch: true });
	});

	// 3. Text output (default)
	it('returns a plain text reply and sends no output field by default', async () => {
		const httpImpl = jest.fn().mockResolvedValue(agentApiResponse);
		const ctx = createContext({
			params: agentInlineParams({ webSearch: false, outputFormat: 'text' }),
			httpImpl,
		});

		const result = await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		expect(body.output).toBeUndefined();
		expect(result[0][0].json.reply).toBe('Hi there');
	});

	// 4. JSON output
	it('forces an object output when Output Format is JSON and no explicit type was chosen', async () => {
		const httpImpl = jest.fn().mockResolvedValue(agentApiResponse);
		const ctx = createContext({
			params: agentInlineParams({ webSearch: false, outputFormat: 'json' }),
			httpImpl,
		});

		await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		expect(body.output).toEqual({ type: 'object' });
	});

	// 5. JSON output with schema
	it('includes the Output JSON Schema when Output Format is JSON', async () => {
		const httpImpl = jest.fn().mockResolvedValue(agentApiResponse);
		const schema = { type: 'object', properties: { name: { type: 'string' } } };
		const ctx = createContext({
			params: agentInlineParams({
				webSearch: false,
				outputFormat: 'json',
				additionalFields: { outputSchema: JSON.stringify(schema) },
			}),
			httpImpl,
		});

		await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		expect(body.output).toEqual({ type: 'object', schema });
	});

	// explicit Array/Enum choice must win over Output Format = JSON
	it('keeps an explicit Structured Output Type of array instead of forcing object', async () => {
		const httpImpl = jest.fn().mockResolvedValue(agentApiResponse);
		const ctx = createContext({
			params: agentInlineParams({
				webSearch: false,
				outputFormat: 'json',
				additionalFields: { outputType: 'array' },
			}),
			httpImpl,
		});

		await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		expect(body.output).toEqual({ type: 'array' });
	});

	// 6. Timeout 30 -> 30000 ms
	it('converts a 30 second timeout to 30000 ms on the HTTP call', async () => {
		const httpImpl = jest.fn().mockResolvedValue(agentApiResponse);
		const ctx = createContext({
			params: agentInlineParams({ webSearch: false, requestTimeoutSeconds: 30 }),
			httpImpl,
		});

		await node.execute.call(ctx);

		expect(httpImpl.mock.calls[0][1].timeout).toBe(30000);
	});

	// 7. Default timeout 300 -> 300000 ms
	it('defaults the timeout to 300 seconds (300000 ms) when not set', async () => {
		const httpImpl = jest.fn().mockResolvedValue(agentApiResponse);
		const params = agentInlineParams({ webSearch: false });
		delete (params as Record<string, unknown>).requestTimeoutSeconds;
		const ctx = createContext({ params, httpImpl });

		await node.execute.call(ctx);

		expect(httpImpl.mock.calls[0][1].timeout).toBe(300000);
	});

	// 8. Invalid timeout
	it('throws a clear error for a timeout outside 1-900 seconds', async () => {
		const httpImpl = jest.fn().mockResolvedValue(agentApiResponse);
		const ctx = createContext({
			params: agentInlineParams({ webSearch: false, requestTimeoutSeconds: 1000 }),
			httpImpl,
		});

		await expect(node.execute.call(ctx)).rejects.toThrow(/Timeout \(Seconds\)/);
		expect(httpImpl).not.toHaveBeenCalled();
	});

	// 9. Existing Agent ID configuration
	it('sends agentId (and no agent object) for Agent Source = Existing Agent', async () => {
		const httpImpl = jest.fn().mockResolvedValue(agentApiResponse);
		const ctx = createContext({
			params: {
				resource: 'agent',
				agentSource: 'id',
				agentId: 'agent_123',
				inputMode: 'simple',
				messageText: 'Hello',
				additionalFields: {},
				simplifyOutput: true,
			},
			httpImpl,
		});

		await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		expect(body.agentId).toBe('agent_123');
		expect(body.agent).toBeUndefined();
	});

	// 10. Chat Completion unchanged
	it('leaves Chat Completion requests unchanged when Output Format is Text', async () => {
		const httpImpl = jest.fn().mockResolvedValue({
			choices: [{ message: { role: 'assistant', content: 'Hi' } }],
			usage: { total_tokens: 5 },
		});
		const ctx = createContext({
			params: {
				resource: 'chatCompletion',
				chatModel: 'gpt-4o',
				inputMode: 'simple',
				systemMessage: '',
				messageText: 'Hello',
				chatAdditionalFields: {},
				outputFormat: 'text',
				simplifyOutput: true,
			},
			httpImpl,
		});

		const result = await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		expect(body).toEqual({
			model: 'gpt-4o',
			messages: [{ role: 'user', content: 'Hello' }],
		});
		expect(result[0][0].json.reply).toBe('Hi');
	});

	it('sends response_format json_object for Chat Completion when Output Format is JSON', async () => {
		const httpImpl = jest.fn().mockResolvedValue({
			choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }],
			usage: { total_tokens: 5 },
		});
		const ctx = createContext({
			params: {
				resource: 'chatCompletion',
				chatModel: 'gpt-4o',
				inputMode: 'simple',
				systemMessage: '',
				messageText: 'Hello',
				chatAdditionalFields: {},
				outputFormat: 'json',
				simplifyOutput: true,
			},
			httpImpl,
		});

		const result = await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		expect(body.response_format).toEqual({ type: 'json_object' });
		expect(result[0][0].json.reply).toEqual({ ok: true });
	});

	// 11. Embedding unchanged
	it('leaves Embedding requests unchanged (aside from the additive timeout)', async () => {
		const httpImpl = jest.fn().mockResolvedValue({
			data: [{ embedding: [0.1, 0.2], index: 0, object: 'embedding' }],
			model: 'text-embedding-3-small',
			usage: { prompt_tokens: 3, total_tokens: 3 },
		});
		const ctx = createContext({
			params: {
				resource: 'embedding',
				embeddingModel: 'text-embedding-3-small',
				embeddingInput: 'hello world',
				encodingFormat: 'float',
				simplifyOutput: true,
			},
			httpImpl,
		});

		const result = await node.execute.call(ctx);

		const body = httpImpl.mock.calls[0][1].body as IDataObject;
		expect(body).toEqual({
			model: 'text-embedding-3-small',
			input: 'hello world',
			encoding_format: 'float',
		});
		expect(result[0][0].json.embeddings).toEqual([[0.1, 0.2]]);
	});

	// 12. Simplify Output unchanged (false -> raw passthrough)
	it('returns the raw API response when Simplify Output is off', async () => {
		const rawResponse = {
			choices: [{ message: { role: 'assistant', content: 'Hi' } }],
			usage: { total_tokens: 5 },
		};
		const httpImpl = jest.fn().mockResolvedValue(rawResponse);
		const ctx = createContext({
			params: {
				resource: 'chatCompletion',
				chatModel: 'gpt-4o',
				inputMode: 'simple',
				systemMessage: '',
				messageText: 'Hello',
				chatAdditionalFields: {},
				outputFormat: 'text',
				simplifyOutput: false,
			},
			httpImpl,
		});

		const result = await node.execute.call(ctx);

		expect(result[0][0].json).toEqual(rawResponse);
	});

	// 13. Multiple input items
	it('processes every input item and calls the API once per item', async () => {
		const httpImpl = jest.fn().mockResolvedValue({
			data: [{ embedding: [0.1], index: 0, object: 'embedding' }],
			model: 'text-embedding-3-small',
			usage: { prompt_tokens: 1, total_tokens: 1 },
		});
		const ctx = createContext({
			params: {
				resource: 'embedding',
				embeddingModel: 'text-embedding-3-small',
				embeddingInput: 'hello',
				encodingFormat: 'float',
				simplifyOutput: true,
			},
			items: [{ json: {} }, { json: {} }, { json: {} }],
			httpImpl,
		});

		const result = await node.execute.call(ctx);

		expect(httpImpl).toHaveBeenCalledTimes(3);
		expect(result[0]).toHaveLength(3);
		expect(result[0].map((item) => item.pairedItem)).toEqual([
			{ item: 0 },
			{ item: 1 },
			{ item: 2 },
		]);
	});

	// 14. API error
	it('propagates API errors, and captures them per item when continueOnFail is on', async () => {
		const httpImpl = jest.fn().mockRejectedValue(new Error('boom'));

		const ctxFailing = createContext({
			params: {
				resource: 'embedding',
				embeddingModel: 'text-embedding-3-small',
				embeddingInput: 'hello',
				encodingFormat: 'float',
				simplifyOutput: true,
			},
			httpImpl,
		});
		await expect(node.execute.call(ctxFailing)).rejects.toThrow('boom');

		const ctxContinue = createContext({
			params: {
				resource: 'embedding',
				embeddingModel: 'text-embedding-3-small',
				embeddingInput: 'hello',
				encodingFormat: 'float',
				simplifyOutput: true,
			},
			httpImpl,
			continueOnFail: true,
		});
		const result = await node.execute.call(ctxContinue);
		expect(result[0][0].json.error).toBe('boom');
	});

	// 15. Timeout error
	it('sends the resolved timeout even when the request ultimately times out', async () => {
		const httpImpl = jest.fn().mockRejectedValue(new Error('timeout of 30000ms exceeded'));
		const ctx = createContext({
			params: {
				resource: 'chatCompletion',
				chatModel: 'gpt-4o',
				inputMode: 'simple',
				systemMessage: '',
				messageText: 'Hello',
				chatAdditionalFields: {},
				outputFormat: 'text',
				requestTimeoutSeconds: 30,
				simplifyOutput: true,
			},
			httpImpl,
			continueOnFail: true,
		});

		const result = await node.execute.call(ctx);

		expect(httpImpl.mock.calls[0][1].timeout).toBe(30000);
		expect(result[0][0].json.error).toBe('timeout of 30000ms exceeded');
	});
});
