import { PassThrough } from 'stream';
import type { IExecuteFunctions } from 'n8n-workflow';
import { consumeLangdockStream } from '../nodes/Langdock/StreamTransport';

function sse(obj: unknown): string {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

function createFakeContext(overrides: { cancelSignal?: AbortSignal } = {}): IExecuteFunctions {
	return {
		getNode: () => ({ name: 'Langdock', type: 'langdock' }),
		getExecutionCancelSignal: () => overrides.cancelSignal,
	} as unknown as IExecuteFunctions;
}

describe('consumeLangdockStream', () => {
	it('resolves with the accumulated result on a clean stream', async () => {
		const stream = new PassThrough();
		const ctx = createFakeContext();

		const promise = consumeLangdockStream(ctx, 0, stream, 5000);
		stream.write(sse({ type: 'text-delta', delta: 'Hi' }));
		stream.write(DONE);
		stream.end();

		const result = await promise;
		expect(result.text).toBe('Hi');
		expect(result.finished).toBe(true);
	});

	// 10. stream without a completion signal
	it('rejects when the stream ends without a finish/[DONE] signal', async () => {
		const stream = new PassThrough();
		const ctx = createFakeContext();

		const promise = consumeLangdockStream(ctx, 0, stream, 5000);
		stream.write(sse({ type: 'text-delta', delta: 'partial' }));
		stream.end();

		await expect(promise).rejects.toThrow(/ended before a finish/);
	});

	// error chunk received mid-stream (no finish afterwards)
	it('rejects with the error chunk message when Langdock sends an error chunk', async () => {
		const stream = new PassThrough();
		const ctx = createFakeContext();

		const promise = consumeLangdockStream(ctx, 0, stream, 5000);
		stream.write(sse({ type: 'error', message: 'rate limited' }));
		stream.end();

		await expect(promise).rejects.toThrow(/error while streaming/);
	});

	// 13. network abort (also representative of a mid-stream 524 style connection drop)
	it('rejects when the underlying stream errors out (network abort)', async () => {
		const stream = new PassThrough();
		const ctx = createFakeContext();

		const promise = consumeLangdockStream(ctx, 0, stream, 5000);
		stream.emit('error', new Error('socket hang up'));

		await expect(promise).rejects.toThrow(/stream connection error/);
	});

	// 14. timeout
	it('rejects and destroys the stream when the deadline is reached before completion', async () => {
		const stream = new PassThrough();
		const destroySpy = jest.spyOn(stream, 'destroy');
		const ctx = createFakeContext();

		const promise = consumeLangdockStream(ctx, 0, stream, 20);
		stream.write(sse({ type: 'text-delta', delta: 'still going' }));
		// Deliberately never send [DONE] / end() within the 20ms deadline.

		await expect(promise).rejects.toThrow(/did not complete within/);
		expect(destroySpy).toHaveBeenCalled();
	});

	// 15. user cancellation
	it('rejects and destroys the stream when execution is cancelled mid-stream', async () => {
		const stream = new PassThrough();
		const destroySpy = jest.spyOn(stream, 'destroy');
		const controller = new AbortController();
		const ctx = createFakeContext({ cancelSignal: controller.signal });

		const promise = consumeLangdockStream(ctx, 0, stream, 5000);
		stream.write(sse({ type: 'text-delta', delta: 'still going' }));
		controller.abort();

		await expect(promise).rejects.toThrow(/cancelled/);
		expect(destroySpy).toHaveBeenCalled();
	});

	it('rejects immediately if execution was already cancelled before the stream started', async () => {
		const stream = new PassThrough();
		const controller = new AbortController();
		controller.abort();
		const ctx = createFakeContext({ cancelSignal: controller.signal });

		const promise = consumeLangdockStream(ctx, 0, stream, 5000);

		await expect(promise).rejects.toThrow(/cancelled/);
	});
});
