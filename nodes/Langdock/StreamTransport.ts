import type { Readable } from 'stream';
import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { LangdockStreamAccumulator, type LangdockStreamResult } from './StreamAccumulator';

/**
 * Reads a Langdock Agent SSE stream to completion and returns the
 * accumulated result, or rejects with a NodeOperationError.
 *
 * Timeout semantics: `timeoutMs` is a single total-duration deadline
 * measured from the moment this function is called (i.e. from when the
 * readable stream is handed to us, after the initial HTTP response was
 * already received) - NOT a per-chunk/idle timeout. As long as the stream
 * finishes (or errors) before the deadline, any number of chunks -
 * including long gaps between them - is fine.
 */
export async function consumeLangdockStream(
	context: IExecuteFunctions,
	itemIndex: number,
	stream: Readable,
	timeoutMs: number,
): Promise<LangdockStreamResult> {
	const accumulator = new LangdockStreamAccumulator();
	const deadlineAt = Date.now() + timeoutMs;

	return await new Promise<LangdockStreamResult>((resolve, reject) => {
		let settled = false;

		const cancelSignal =
			typeof context.getExecutionCancelSignal === 'function' ? context.getExecutionCancelSignal() : undefined;

		const cleanup = () => {
			clearTimeout(timer);
			stream.removeListener('data', onData);
			stream.removeListener('end', onEnd);
			stream.removeListener('error', onError);
			cancelSignal?.removeEventListener('abort', onCancel);
		};

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			stream.destroy();
			reject(error);
		};

		const succeed = () => {
			if (settled) return;

			const result = accumulator.getResult();

			// An error chunk is diagnostic even if the stream never sent an explicit
			// finish/[DONE] afterwards (the error effectively replaces it), so this is
			// checked before the "ended early" fallback.
			if (result.errorChunk) {
				fail(
					new NodeOperationError(
						context.getNode(),
						`Langdock returned an error while streaming: ${JSON.stringify(result.errorChunk).slice(0, 500)}`,
						{ itemIndex },
					),
				);
				return;
			}

			if (!result.finished) {
				fail(
					new NodeOperationError(
						context.getNode(),
						'The Langdock stream ended before a finish/[DONE] signal was received (connection closed early).',
						{ itemIndex },
					),
				);
				return;
			}

			settled = true;
			cleanup();
			resolve(result);
		};

		const onData = (chunk: Buffer) => {
			accumulator.pushChunk(chunk);
		};
		const onEnd = () => succeed();
		const onError = (err: Error) => {
			fail(new NodeOperationError(context.getNode(), `Langdock stream connection error: ${err.message}`, { itemIndex }));
		};
		const onCancel = () => {
			fail(new NodeOperationError(context.getNode(), 'Execution was cancelled while streaming from Langdock.', { itemIndex }));
		};

		const remaining = Math.max(0, deadlineAt - Date.now());
		const timer = setTimeout(() => {
			fail(
				new NodeOperationError(
					context.getNode(),
					`Langdock stream did not complete within the configured Timeout (Seconds) (${Math.round(timeoutMs / 1000)}s).`,
					{ itemIndex },
				),
			);
		}, remaining);

		if (cancelSignal) {
			if (cancelSignal.aborted) {
				onCancel();
				return;
			}
			cancelSignal.addEventListener('abort', onCancel, { once: true });
		}

		stream.on('data', onData);
		stream.on('end', onEnd);
		stream.on('error', onError);
	});
}
