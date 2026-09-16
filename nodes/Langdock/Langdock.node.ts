import type { Readable } from 'stream';
import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { consumeLangdockStream } from './StreamTransport';

function getBaseUrl(credentials: IDataObject): string {
	return credentials.environment === 'dedicated'
		? (credentials.baseUrl as string).replace(/\/+$/, '')
		: 'https://api.langdock.com';
}

function resolveTimeoutMs(context: IExecuteFunctions, itemIndex: number): number {
	const raw = context.getNodeParameter('requestTimeoutSeconds', itemIndex, 300) as number | string;
	const seconds = typeof raw === 'number' ? raw : Number(raw);

	if (!Number.isFinite(seconds) || seconds < 1 || seconds > 900) {
		throw new NodeOperationError(
			context.getNode(),
			`Invalid Timeout (Seconds) value "${String(raw)}". Must be a number between 1 and 900.`,
			{ itemIndex },
		);
	}

	return Math.round(seconds * 1000);
}

export class Langdock implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Langdock',
		name: 'langdock',
		icon: 'file:langdock.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["resource"]}}',
		description: 'Send messages to Langdock Agents, run chat completions and create embeddings',
		defaults: {
			name: 'Langdock',
		},
		inputs: ['main'],
		outputs: ['main'],
		usableAsTool: true,
		credentials: [
			{
				name: 'langdockApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Agent',
						value: 'agent',
						description: 'Send a message to a Langdock Agent and get its reply',
						action: 'Send a message to an agent',
					},
					{
						name: 'Chat Completion',
						value: 'chatCompletion',
						description: 'OpenAI-compatible chat completion across supported providers (OpenAI, Anthropic, Mistral, Google)',
						action: 'Create a chat completion',
					},
					{
						name: 'Embedding',
						value: 'embedding',
						description: 'Create text embeddings',
						action: 'Create an embedding',
					},
				],
				default: 'agent',
			},

			// ---------------------------------------------------------------
			// Agent
			// ---------------------------------------------------------------
			{
				displayName: 'Agent Source',
				name: 'agentSource',
				type: 'options',
				displayOptions: { show: { resource: ['agent'] } },
				options: [
					{ name: 'Existing Agent (by ID)', value: 'id' },
					{ name: 'Temporary Agent (Inline Configuration)', value: 'inline' },
				],
				default: 'id',
				description: 'Whether to call an Agent already configured in Langdock or define one inline for this request only',
			},
			{
				displayName: 'Agent ID',
				name: 'agentId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['agent'], agentSource: ['id'] } },
				description: 'ID of the Agent configured in Langdock',
			},
			{
				displayName: 'Agent Name',
				name: 'agentName',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['agent'], agentSource: ['inline'] } },
				description: 'Name of the temporary Agent (max. 64 characters).',
			},
			{
				displayName: 'Instructions',
				name: 'agentInstructions',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['agent'], agentSource: ['inline'] } },
				description: 'System instructions for the temporary Agent (max. 16384 characters).',
			},
			{
				displayName: 'Model Name or ID',
				name: 'agentModel',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getAgentModels' },
				default: 'gpt-4o',
				displayOptions: { show: { resource: ['agent'], agentSource: ['inline'] } },
				description: 'Model ID to use for the temporary Agent. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Temperature',
				name: 'agentTemperature',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
				default: 0.7,
				displayOptions: { show: { resource: ['agent'], agentSource: ['inline'] } },
			},
			{
				displayName: 'Web Search',
				name: 'webSearch',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['agent'], agentSource: ['inline'] } },
				description: "Whether to enable the temporary Agent's web search capability for this request",
			},
			{
				displayName: 'Stream Response',
				name: 'streamResponse',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['agent'] } },
				description:
					'Whether to keep the connection open and read the reply incrementally as Langdock sends it, instead of waiting for one final response. Useful for long web-research requests that would otherwise hit a proxy timeout. Streaming keeps the connection open only as long as Langdock keeps sending data - it does not lift or guarantee the external Cloudflare/Langdock request limit.',
			},

			// ---------------------------------------------------------------
			// Chat Completion
			// ---------------------------------------------------------------
			{
				displayName: 'Model Name or ID',
				name: 'chatModel',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getChatModels' },
				default: 'gpt-4o',
				required: true,
				displayOptions: { show: { resource: ['chatCompletion'] } },
				description: 'Model to use, as offered by Langdock for your workspace and region. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'System Message',
				name: 'systemMessage',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				displayOptions: { show: { resource: ['chatCompletion'], inputMode: ['simple'] } },
				description: 'Optional system prompt sent before the user message',
			},

			// ---------------------------------------------------------------
			// Shared: message input (Agent + Chat Completion)
			// ---------------------------------------------------------------
			{
				displayName: 'Input Mode',
				name: 'inputMode',
				type: 'options',
				displayOptions: { show: { resource: ['agent', 'chatCompletion'] } },
				options: [
					{ name: 'Simple (Single Message)', value: 'simple' },
					{ name: 'JSON (Full Messages Array)', value: 'json' },
				],
				default: 'simple',
			},
			{
				displayName: 'Message Text',
				name: 'messageText',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['agent', 'chatCompletion'], inputMode: ['simple'] } },
				description: 'The user message to send',
			},
			{
				displayName: 'Messages (JSON)',
				name: 'messagesJson',
				type: 'json',
				default: '[\n  {\n    "id": "1",\n    "role": "user",\n    "parts": [ { "type": "text", "text": "Hello" } ]\n  }\n]',
				required: true,
				displayOptions: { show: { resource: ['agent'], inputMode: ['json'] } },
				description: 'Full messages array in Langdock UIMessage format (ID, role, parts)',
			},
			{
				displayName: 'Messages (JSON)',
				name: 'messagesJson',
				type: 'json',
				default: '[\n  { "role": "user", "content": "Hello" }\n]',
				required: true,
				displayOptions: { show: { resource: ['chatCompletion'], inputMode: ['json'] } },
				description: 'Full messages array in OpenAI format (role, content)',
			},
			{
				displayName: 'Output Format',
				name: 'outputFormat',
				type: 'options',
				displayOptions: { show: { resource: ['agent', 'chatCompletion'] } },
				options: [
					{ name: 'Text', value: 'text' },
					{ name: 'JSON', value: 'json' },
				],
				default: 'text',
				description:
					'Whether to return the free-form text reply (default) or technically force a JSON response. For Agent, JSON defaults to an object output unless Structured Output Type in Additional Fields already requests Array or Enum. For Chat Completion, JSON uses the OpenAI-compatible json_object response format, if supported by the selected model.',
			},

			// ---------------------------------------------------------------
			// Embedding
			// ---------------------------------------------------------------
			{
				displayName: 'Model Name or ID',
				name: 'embeddingModel',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getEmbeddingModels' },
				default: 'text-embedding-3-small',
				required: true,
				displayOptions: { show: { resource: ['embedding'] } },
				description: 'Embedding model to use. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Text',
				name: 'embeddingInput',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['embedding'] } },
				description:
					'Text to embed. Use an expression that resolves to an array of strings to embed multiple texts in one request.',
			},
			{
				displayName: 'Encoding Format',
				name: 'encodingFormat',
				type: 'options',
				displayOptions: { show: { resource: ['embedding'] } },
				options: [
					{ name: 'Float', value: 'float' },
					{ name: 'Base64', value: 'base64' },
				],
				default: 'float',
			},

			// ---------------------------------------------------------------
			// Additional Fields
			// ---------------------------------------------------------------
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['agent'] } },
				options: [
					{
						displayName: 'Attachment IDs',
						name: 'attachmentIds',
						type: 'string',
						default: '',
						description: 'Comma-separated Upload API UUIDs to attach to the message',
					},
					{
						displayName: 'Enum Values',
						name: 'enumValues',
						type: 'string',
						default: '',
						description: 'Comma-separated list of allowed values',
						displayOptions: { show: { outputType: ['enum'] } },
					},
					{
						displayName: 'Max Steps',
						name: 'maxSteps',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 20 },
						default: 5,
						description: 'Maximum number of tool-use steps the Agent may take',
					},
					{
						displayName: 'Output JSON Schema',
						name: 'outputSchema',
						type: 'json',
						default: '',
						description:
							'Optional JSON Schema for the structured output. Used when Structured Output Type is Object/Array, or together with Output Format = JSON.',
					},
					{
						displayName: 'Previous Messages (JSON)',
						name: 'previousMessages',
						type: 'json',
						default: '',
						description: 'Array of earlier messages (UIMessage format) to prepend, for multi-turn conversations',
					},
					{
						displayName: 'Structured Output Type',
						name: 'outputType',
						type: 'options',
						options: [
							{ name: 'None', value: 'none' },
							{ name: 'Object', value: 'object' },
							{ name: 'Array', value: 'array' },
							{ name: 'Enum', value: 'enum' },
						],
						default: 'none',
						description: 'Request structured output from the Agent instead of free-form text',
					},
				],
			},
			{
				displayName: 'Additional Fields',
				name: 'chatAdditionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['chatCompletion'] } },
				options: [
					{
						displayName: 'Frequency Penalty',
						name: 'frequency_penalty',
						type: 'number',
						typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 2 },
						default: 0,
					},
					{
						displayName: 'Max Tokens',
						name: 'max_tokens',
						type: 'number',
						default: 1024,
					},
					{
						displayName: 'Presence Penalty',
						name: 'presence_penalty',
						type: 'number',
						typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 2 },
						default: 0,
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
						default: 1,
					},
					{
						displayName: 'Top P',
						name: 'top_p',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
						default: 1,
					},
				],
			},

			{
				displayName: 'Timeout (Seconds)',
				name: 'requestTimeoutSeconds',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 900 },
				default: 300,
				displayOptions: { show: { resource: ['agent', 'chatCompletion', 'embedding'] } },
				description:
					'Maximum time to wait for the Langdock API response, in seconds (1-900). Langdock itself may enforce a shorter server-side limit (around 100 seconds) for non-streaming requests, independent of this value; use streaming or a smaller request if you hit that limit.',
			},
			{
				displayName: 'Simplify Output',
				name: 'simplifyOutput',
				type: 'boolean',
				default: true,
				description: 'Whether to return a simplified version of the response instead of the raw API response',
			},
		],
	};

	methods = {
		loadOptions: {
			async getAgentModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials('langdockApi');
				const baseUrl = getBaseUrl(credentials);

				const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'langdockApi', {
					method: 'GET',
					url: `${baseUrl}/agent/v1/models`,
					json: true,
				})) as IDataObject;

				const models = (response.data as IDataObject[]) || [];
				return models
					.map((model) => ({ name: model.id as string, value: model.id as string }))
					.sort((a, b) => a.name.localeCompare(b.name));
			},

			async getChatModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials('langdockApi');
				const baseUrl = getBaseUrl(credentials);
				const region = (credentials.region as string) || 'eu';

				const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'langdockApi', {
					method: 'GET',
					url: `${baseUrl}/openai/${region}/v1/models`,
					json: true,
				})) as IDataObject;

				const models = (response.data as IDataObject[]) || [];
				return models
					.map((model) => ({ name: model.id as string, value: model.id as string }))
					.sort((a, b) => a.name.localeCompare(b.name));
			},

			async getEmbeddingModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials('langdockApi');
				const baseUrl = getBaseUrl(credentials);
				const region = (credentials.region as string) || 'eu';

				const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'langdockApi', {
					method: 'GET',
					url: `${baseUrl}/openai/${region}/v1/models`,
					json: true,
				})) as IDataObject;

				const models = (response.data as IDataObject[]) || [];
				const embeddingModels = models.filter((model) => (model.id as string).toLowerCase().includes('embed'));
				const list = embeddingModels.length ? embeddingModels : models;

				return list
					.map((model) => ({ name: model.id as string, value: model.id as string }))
					.sort((a, b) => a.name.localeCompare(b.name));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('langdockApi');
		const baseUrl = getBaseUrl(credentials);
		const region = (credentials.region as string) || 'eu';

		const resource = this.getNodeParameter('resource', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const simplifyOutput = this.getNodeParameter('simplifyOutput', i, true) as boolean;
				let responseData: IDataObject = {};

				if (resource === 'agent') {
					const timeoutMs = resolveTimeoutMs(this, i);
					const agentSource = this.getNodeParameter('agentSource', i) as string;
					const outputFormat = this.getNodeParameter('outputFormat', i, 'text') as string;
					const streamResponse = this.getNodeParameter('streamResponse', i, false) as boolean;
					const body: IDataObject = {};

					if (agentSource === 'id') {
						body.agentId = this.getNodeParameter('agentId', i) as string;
					} else {
						const agentConfig: IDataObject = {
							name: this.getNodeParameter('agentName', i) as string,
							instructions: this.getNodeParameter('agentInstructions', i) as string,
							model: this.getNodeParameter('agentModel', i) as string,
							temperature: this.getNodeParameter('agentTemperature', i) as number,
						};

						const webSearch = this.getNodeParameter('webSearch', i, false) as boolean;
						if (webSearch) {
							agentConfig.capabilities = { webSearch: true };
						}

						body.agent = agentConfig;
					}

					const additionalFields = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
					const inputMode = this.getNodeParameter('inputMode', i) as string;

					let messages: IDataObject[];
					if (inputMode === 'simple') {
						const messageText = this.getNodeParameter('messageText', i) as string;

						let previousMessages: IDataObject[] = [];
						if (additionalFields.previousMessages) {
							const raw = additionalFields.previousMessages;
							previousMessages = typeof raw === 'string' ? JSON.parse(raw) : (raw as IDataObject[]);
						}

						const userMessage: IDataObject = {
							id: `n8n-${Date.now()}-${i}`,
							role: 'user',
							parts: [{ type: 'text', text: messageText }],
						};

						if (additionalFields.attachmentIds) {
							const ids = (additionalFields.attachmentIds as string)
								.split(',')
								.map((s) => s.trim())
								.filter(Boolean);
							if (ids.length) {
								userMessage.metadata = { attachments: ids };
							}
						}

						messages = [...previousMessages, userMessage];
					} else {
						const raw = this.getNodeParameter('messagesJson', i) as string | IDataObject[];
						messages = typeof raw === 'string' ? JSON.parse(raw) : raw;
					}
					body.messages = messages;

					if (additionalFields.maxSteps) {
						body.maxSteps = additionalFields.maxSteps;
					}

					if (additionalFields.outputType && additionalFields.outputType !== 'none') {
						const output: IDataObject = { type: additionalFields.outputType };
						if (additionalFields.outputType === 'enum') {
							output.enum = ((additionalFields.enumValues as string) || '')
								.split(',')
								.map((s) => s.trim())
								.filter(Boolean);
						} else if (additionalFields.outputSchema) {
							const rawSchema = additionalFields.outputSchema;
							output.schema = typeof rawSchema === 'string' ? JSON.parse(rawSchema) : rawSchema;
						}
						body.output = output;
					}

					// Output Format = JSON forces a structured (object) output, but never
					// overrides an explicit Array/Enum choice made above via Structured Output Type.
					if (outputFormat === 'json' && !body.output) {
						const output: IDataObject = { type: 'object' };
						if (additionalFields.outputSchema) {
							const rawSchema = additionalFields.outputSchema;
							output.schema = typeof rawSchema === 'string' ? JSON.parse(rawSchema) : rawSchema;
						}
						body.output = output;
					}

					if (streamResponse) {
						body.stream = true;

						const fullResponse = (await this.helpers.httpRequestWithAuthentication.call(this, 'langdockApi', {
							method: 'POST',
							url: `${baseUrl}/agent/v1/chat/completions`,
							body,
							json: true,
							encoding: 'stream',
							returnFullResponse: true,
							timeout: timeoutMs,
						})) as IN8nHttpFullResponse;

						const streamResult = await consumeLangdockStream(this, i, fullResponse.body as Readable, timeoutMs);

						const assembledMessage: IDataObject = {
							id: `n8n-stream-${Date.now()}-${i}`,
							role: 'assistant',
							content: streamResult.text,
						};
						responseData = { messages: [assembledMessage] };
						if (streamResult.output !== undefined) responseData.output = streamResult.output;
						if (streamResult.sources.length) responseData.sources = streamResult.sources;
						if (streamResult.toolCalls.length) responseData.toolCalls = streamResult.toolCalls;

						if (simplifyOutput) {
							if (outputFormat === 'json') {
								let jsonOutput = streamResult.output;
								if (jsonOutput === undefined) {
									try {
										jsonOutput = JSON.parse(streamResult.text);
									} catch {
										throw new NodeOperationError(
											this.getNode(),
											'Output Format is JSON, but the streamed response did not contain valid JSON once complete.',
											{ itemIndex: i },
										);
									}
								}
								responseData = { reply: streamResult.text, output: jsonOutput as IDataObject };
							} else {
								responseData = { reply: streamResult.text };
							}
						}
					} else {
						responseData = (await this.helpers.httpRequestWithAuthentication.call(this, 'langdockApi', {
							method: 'POST',
							url: `${baseUrl}/agent/v1/chat/completions`,
							body,
							json: true,
							timeout: timeoutMs,
						})) as IDataObject;

						if (simplifyOutput) {
							const apiMessages = (responseData.messages as IDataObject[]) || [];
							const last = apiMessages[apiMessages.length - 1] as IDataObject | undefined;
							responseData = {
								reply: last?.content ?? '',
								output: responseData.output,
							};
						}
					}
				} else if (resource === 'chatCompletion') {
					const timeoutMs = resolveTimeoutMs(this, i);
					const model = this.getNodeParameter('chatModel', i) as string;
					const inputMode = this.getNodeParameter('inputMode', i) as string;
					const outputFormat = this.getNodeParameter('outputFormat', i, 'text') as string;
					const chatAdditionalFields = this.getNodeParameter('chatAdditionalFields', i, {}) as IDataObject;

					let messages: IDataObject[];
					if (inputMode === 'simple') {
						const systemMessage = this.getNodeParameter('systemMessage', i, '') as string;
						const messageText = this.getNodeParameter('messageText', i) as string;
						messages = [];
						if (systemMessage) {
							messages.push({ role: 'system', content: systemMessage });
						}
						messages.push({ role: 'user', content: messageText });
					} else {
						const raw = this.getNodeParameter('messagesJson', i) as string | IDataObject[];
						messages = typeof raw === 'string' ? JSON.parse(raw) : raw;
					}

					const body: IDataObject = {
						model,
						messages,
						...chatAdditionalFields,
					};

					if (outputFormat === 'json') {
						body.response_format = { type: 'json_object' };
					}

					responseData = (await this.helpers.httpRequestWithAuthentication.call(this, 'langdockApi', {
						method: 'POST',
						url: `${baseUrl}/openai/${region}/v1/chat/completions`,
						body,
						json: true,
						timeout: timeoutMs,
					})) as IDataObject;

					if (simplifyOutput) {
						const choices = (responseData.choices as IDataObject[]) || [];
						const message = (choices[0]?.message as IDataObject) || {};
						let reply: string | IDataObject = (message.content as string) ?? '';

						if (outputFormat === 'json' && typeof reply === 'string') {
							try {
								reply = JSON.parse(reply);
							} catch {
								// Model did not return valid JSON; fall back to the raw string.
							}
						}

						responseData = { reply, usage: responseData.usage };
					}
				} else if (resource === 'embedding') {
					const timeoutMs = resolveTimeoutMs(this, i);
					const model = this.getNodeParameter('embeddingModel', i) as string;
					const input = this.getNodeParameter('embeddingInput', i) as string | string[];
					const encodingFormat = this.getNodeParameter('encodingFormat', i, 'float') as string;

					const body: IDataObject = {
						model,
						input,
						encoding_format: encodingFormat,
					};

					responseData = (await this.helpers.httpRequestWithAuthentication.call(this, 'langdockApi', {
						method: 'POST',
						url: `${baseUrl}/openai/${region}/v1/embeddings`,
						body,
						json: true,
						timeout: timeoutMs,
					})) as IDataObject;

					if (simplifyOutput) {
						const data = (responseData.data as IDataObject[]) || [];
						responseData = {
							embeddings: data.map((d) => d.embedding),
							model: responseData.model,
							usage: responseData.usage,
						};
					}
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown resource: ${resource}`);
				}

				returnData.push({ json: responseData, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
