import type { IDataObject } from 'n8n-workflow';

export interface LangdockStreamResult {
	text: string;
	output?: unknown;
	sources: IDataObject[];
	toolCalls: IDataObject[];
	finished: boolean;
	errorChunk?: IDataObject;
	warnings: string[];
}

/**
 * Incrementally parses Langdock's Vercel AI SDK compatible SSE stream
 * (`data: {...}\n\n` lines, terminated by a literal `data: [DONE]`) and
 * accumulates it into a single result. Network chunk boundaries never
 * line up with SSE line boundaries, so partial lines are buffered across
 * calls to pushChunk().
 */
export class LangdockStreamAccumulator {
	private buffer = '';

	private result: LangdockStreamResult = {
		text: '',
		sources: [],
		toolCalls: [],
		finished: false,
		warnings: [],
	};

	pushChunk(chunk: Buffer | string): void {
		this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

		const lines = this.buffer.split('\n');
		// The last split segment may be an incomplete line (chunk boundary
		// mid-line) - keep it buffered until more data arrives.
		this.buffer = lines.pop() ?? '';

		for (const rawLine of lines) {
			this.processLine(rawLine);
		}
	}

	getResult(): LangdockStreamResult {
		return this.result;
	}

	private processLine(rawLine: string): void {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

		if (line === '') return; // blank line: SSE event separator / keepalive
		if (line.startsWith(':')) return; // SSE comment / heartbeat
		if (!line.startsWith('data:')) return; // ignore other SSE fields (event:, id:, retry:)

		const payload = line.slice('data:'.length).trim();
		if (payload === '[DONE]') {
			this.result.finished = true;
			return;
		}

		let json: IDataObject;
		try {
			json = JSON.parse(payload) as IDataObject;
		} catch {
			this.result.warnings.push('Received a data chunk that was not valid JSON and was skipped.');
			return;
		}

		this.applyChunk(json);
	}

	private applyChunk(chunk: IDataObject): void {
		const type = chunk.type as string | undefined;

		if (type === 'text-delta') {
			const delta = (chunk.delta ?? chunk.text ?? chunk.textDelta) as string | undefined;
			if (typeof delta === 'string') this.result.text += delta;
			return;
		}

		if (type === 'source-url' || type === 'source-document') {
			this.result.sources.push(chunk);
			return;
		}

		if (type === 'error') {
			this.result.errorChunk = chunk;
			return;
		}

		if (type === 'finish' || type === 'finish-step') {
			this.result.finished = true;
			if (chunk.output !== undefined) this.result.output = chunk.output;
			return;
		}

		if (type && type.startsWith('tool-')) {
			this.result.toolCalls.push(chunk);
			return;
		}

		// Reasoning deltas, start events, and any other/unknown chunk types are
		// intentionally ignored rather than treated as errors (forward-compatible,
		// "robust" parsing) - but an explicit `output` field is still honored
		// wherever it shows up.
		if (chunk.output !== undefined) this.result.output = chunk.output;
	}
}
