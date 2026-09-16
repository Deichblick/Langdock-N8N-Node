import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { Langdock } from '../nodes/Langdock/Langdock.node';

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

function agentParams(overrides: Record<string, unknown> = {}) {
	return {
		resource: 'agent',
		agentSource: 'inline',
		agentName: 'Test Agent',
		agentInstructions: 'Be helpful',
		agentModel: 'gpt-4o',
		agentTemperature: 0.7,
		webSearch: false,
		streamResponse: false,
		inputMode: 'simple',
		messageText: 'Hello',
		simplifyOutput: true,
		outputFormat: 'text',
		...overrides,
	};
}

const agentApiResponse = { messages: [{ id: '2', role: 'assistant', content: 'Hi there' }] };

describe('Langdock node - retry', () => {
	let node: Langdock;

	beforeEach(() => {
		node = new Langdock();
	});

	it('does not retry when Retry Transient Errors is off (default)', async () => {
		const httpImpl = jest.fn().mockRejectedValue(new Error('Request failed with status code 503'));
		const ctx = createContext({
			params: agentParams({ additionalFields: {} }),
			httpImpl,
			continueOnFail: true,
		});

		const result = await node.execute.call(ctx);

		expect(httpImpl).toHaveBeenCalledTimes(1);
		expect(result[0][0].json.error).toBe('Request failed with status code 503');
	});

	it('retries a transient failure and eventually succeeds when Retry Transient Errors is on', async () => {
		const httpImpl = jest
			.fn()
			.mockRejectedValueOnce(new Error('Request failed with status code 503'))
			.mockResolvedValueOnce(agentApiResponse);
		const ctx = createContext({
			params: agentParams({
				additionalFields: { retryTransientErrors: true, maxRetries: 3, retryDelaySeconds: 0 },
			}),
			httpImpl,
		});

		const result = await node.execute.call(ctx);

		expect(httpImpl).toHaveBeenCalledTimes(2);
		expect(result[0][0].json).toEqual({ reply: 'Hi there', output: undefined });
	});

	it('gives up after Max Retries and reports a structured error item', async () => {
		const httpImpl = jest.fn().mockRejectedValue(new Error('Request failed with status code 524'));
		const ctx = createContext({
			params: agentParams({
				additionalFields: { retryTransientErrors: true, maxRetries: 2, retryDelaySeconds: 0 },
			}),
			httpImpl,
			continueOnFail: true,
		});

		const result = await node.execute.call(ctx);
		const json = result[0][0].json as IDataObject;

		expect(httpImpl).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
		expect(json.langdockError).toBe(true);
		expect(json.error).toBe('Request failed with status code 524');
		expect(json.statusCode).toBe(524);
		expect(json.attempts).toBe(3);
		expect(json.retryable).toBe(true);
	});

	it('does not retry a non-transient (e.g. 400) error even when Retry Transient Errors is on', async () => {
		const httpImpl = jest.fn().mockRejectedValue(new Error('Request failed with status code 400'));
		const ctx = createContext({
			params: agentParams({
				additionalFields: { retryTransientErrors: true, maxRetries: 3, retryDelaySeconds: 0 },
			}),
			httpImpl,
			continueOnFail: true,
		});

		const result = await node.execute.call(ctx);

		expect(httpImpl).toHaveBeenCalledTimes(1);
		expect(result[0][0].json.retryable).toBe(false);
	});

	it('does not retry a cancelled/user-aborted error', async () => {
		const httpImpl = jest.fn().mockRejectedValue(new Error('Execution was cancelled while streaming from Langdock.'));
		const ctx = createContext({
			params: agentParams({
				additionalFields: { retryTransientErrors: true, maxRetries: 3, retryDelaySeconds: 0 },
			}),
			httpImpl,
			continueOnFail: true,
		});

		const result = await node.execute.call(ctx);

		expect(httpImpl).toHaveBeenCalledTimes(1);
		expect(result[0][0].json.retryable).toBe(false);
	});

	it('leaves Chat Completion and Embedding error items backward compatible (still has .error)', async () => {
		const httpImpl = jest.fn().mockRejectedValue(new Error('boom'));
		const ctx = createContext({
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

		const result = await node.execute.call(ctx);
		expect(result[0][0].json.error).toBe('boom');
	});
});
