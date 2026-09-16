import { LangdockStreamAccumulator } from '../nodes/Langdock/StreamAccumulator';

function sse(obj: unknown): string {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

describe('LangdockStreamAccumulator', () => {
	// 3. multiple text chunks
	it('accumulates multiple text-delta chunks in order', () => {
		const acc = new LangdockStreamAccumulator();
		acc.pushChunk(sse({ type: 'text-delta', delta: 'Hello' }));
		acc.pushChunk(sse({ type: 'text-delta', delta: ', ' }));
		acc.pushChunk(sse({ type: 'text-delta', delta: 'world!' }));
		acc.pushChunk(DONE);

		expect(acc.getResult().text).toBe('Hello, world!');
		expect(acc.getResult().finished).toBe(true);
	});

	// 4. SSE parsing across network chunk boundaries (line split mid-way)
	it('buffers a line that is split across two pushChunk calls', () => {
		const acc = new LangdockStreamAccumulator();
		const full = sse({ type: 'text-delta', delta: 'split-line' });
		const cut = Math.floor(full.length / 2);

		acc.pushChunk(full.slice(0, cut));
		acc.pushChunk(full.slice(cut));
		acc.pushChunk(DONE);

		expect(acc.getResult().text).toBe('split-line');
	});

	// 5. structured output delivered on the finish chunk
	it('captures structured output carried on a finish chunk', () => {
		const acc = new LangdockStreamAccumulator();
		acc.pushChunk(sse({ type: 'text-delta', delta: '{"a":1}' }));
		acc.pushChunk(sse({ type: 'finish', output: { a: 1 } }));

		const result = acc.getResult();
		expect(result.finished).toBe(true);
		expect(result.output).toEqual({ a: 1 });
	});

	// 6. tool-call / tool-result chunks
	it('collects tool-input and tool-output chunks, including dynamic tool-<name> types', () => {
		const acc = new LangdockStreamAccumulator();
		acc.pushChunk(sse({ type: 'tool-input-start', toolCallId: '1', toolName: 'webSearch' }));
		acc.pushChunk(sse({ type: 'tool-output-available', toolCallId: '1', output: 'result' }));
		acc.pushChunk(sse({ type: 'tool-searchWeb', toolCallId: '2' }));
		acc.pushChunk(DONE);

		expect(acc.getResult().toolCalls).toHaveLength(3);
	});

	// 7. source-url chunks
	it('collects source-url and source-document chunks', () => {
		const acc = new LangdockStreamAccumulator();
		acc.pushChunk(sse({ type: 'source-url', url: 'https://example.com' }));
		acc.pushChunk(sse({ type: 'source-document', title: 'doc.pdf' }));
		acc.pushChunk(DONE);

		expect(acc.getResult().sources).toEqual([
			{ type: 'source-url', url: 'https://example.com' },
			{ type: 'source-document', title: 'doc.pdf' },
		]);
	});

	// 8. completion / done signal
	it('marks finished on a [DONE] line, and separately on a finish chunk', () => {
		const acc1 = new LangdockStreamAccumulator();
		acc1.pushChunk(DONE);
		expect(acc1.getResult().finished).toBe(true);

		const acc2 = new LangdockStreamAccumulator();
		acc2.pushChunk(sse({ type: 'finish' }));
		expect(acc2.getResult().finished).toBe(true);
	});

	// 9. empty keepalive chunks / SSE comments
	it('ignores blank lines and SSE comment (heartbeat) lines without affecting state', () => {
		const acc = new LangdockStreamAccumulator();
		acc.pushChunk('\n');
		acc.pushChunk(': keep-alive\n\n');
		acc.pushChunk(sse({ type: 'text-delta', delta: 'ok' }));
		acc.pushChunk(DONE);

		expect(acc.getResult().text).toBe('ok');
		expect(acc.getResult().warnings).toHaveLength(0);
	});

	// multiple SSE events within a single TCP-level chunk
	it('parses several data: events delivered in one pushChunk call', () => {
		const acc = new LangdockStreamAccumulator();
		const combined =
			sse({ type: 'text-delta', delta: 'a' }) + sse({ type: 'text-delta', delta: 'b' }) + DONE;

		acc.pushChunk(combined);

		expect(acc.getResult().text).toBe('ab');
		expect(acc.getResult().finished).toBe(true);
	});

	// malformed JSON chunk
	it('records a warning and continues when a data: line is not valid JSON', () => {
		const acc = new LangdockStreamAccumulator();
		acc.pushChunk('data: {not valid json\n\n');
		acc.pushChunk(sse({ type: 'text-delta', delta: 'still works' }));
		acc.pushChunk(DONE);

		expect(acc.getResult().warnings).toHaveLength(1);
		expect(acc.getResult().text).toBe('still works');
		expect(acc.getResult().finished).toBe(true);
	});

	// error chunk
	it('captures an error chunk sent mid-stream', () => {
		const acc = new LangdockStreamAccumulator();
		acc.pushChunk(sse({ type: 'error', message: 'rate limited' }));

		expect(acc.getResult().errorChunk).toEqual({ type: 'error', message: 'rate limited' });
	});
});
