import type {
	IAuthenticateGeneric,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class LangdockApi implements ICredentialType {
	name = 'langdockApi';

	displayName = 'Langdock API';

	documentationUrl = 'https://docs.langdock.com/en/developer/overview/api-introduction';

	properties: INodeProperties[] = [
		{
			displayName: 'Environment',
			name: 'environment',
			type: 'options',
			options: [
				{
					name: 'Langdock Cloud',
					value: 'cloud',
				},
				{
					name: 'Dedicated Deployment',
					value: 'dedicated',
				},
			],
			default: 'cloud',
			description: 'Whether to call the shared Langdock Cloud API or a dedicated (self-hosted) deployment',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Personal or workspace API key. Create one in Langdock under Settings → API Keys. Make sure the key has the scopes required for the resources you plan to use (e.g. AGENT_API).',
		},
		{
			displayName: 'Region',
			name: 'region',
			type: 'options',
			options: [
				{ name: 'EU', value: 'eu' },
				{ name: 'US', value: 'us' },
			],
			default: 'eu',
			description:
				'Data region used for the OpenAI-compatible chat completion and embedding endpoints (openai/{region}/...)',
			displayOptions: {
				show: {
					environment: ['cloud'],
				},
			},
		},
		{
			displayName: 'Deployment Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'https://your-domain.example.com/api/public',
			description: 'Base URL of your dedicated Langdock deployment, e.g. https://your-domain.example.com/api/public',
			required: true,
			displayOptions: {
				show: {
					environment: ['dedicated'],
				},
			},
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};
}
