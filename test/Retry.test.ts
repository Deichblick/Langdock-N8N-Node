import { buildErrorItem, getStatusCode, isRetryableError, withTransientRetries } from '../nodes/Langdock/Retry';

describe('Retry - getStatusCode', () => {
	it('reads statusCode/httpCode/status/response.statusCode off the error object', () => {
		expect(getStatusCode({ statusCode: 429 })).toBe(429);
		expect(getStatusCode({ httpCode: 502 })).toBe(502);
		expect(getStatusCode({ status: 503 })).toBe(503);
		expect(getStatusCode({ response: { statusCode: 524 } })).toBe(524);
	});

	it('falls back to extracting a status code from the error message', () => {
		expect(getStatusCode(new Error('Request failed with status code 524'))).toBe(524);
	});

	it('returns undefined when no status code is present anywhere', () => {
		expect(getStatusCode(new Error('boom'))).toBeUndefined();
	});
});

describe('Retry - isRetryableError', () => {
	it.each([408, 429, 502, 503, 504, 524])('treats HTTP %d as retryable', (code) => {
		expect(isRetryableError({ statusCode: code })).toBe(true);
	});

	it('treats HTTP 400 as not retryable', () => {
		expect(isRetryableError({ statusCode: 400 })).toBe(false);
	});

	it.each([
		'The Langdock stream ended before a finish/[DONE] signal was received (connection closed early).',
		'Langdock stream connection error: socket hang up',
		'Langdock stream did not complete within the configured Timeout (Seconds) (30s).',
	])('treats the StreamTransport error message %j as retryable', (message) => {
		expect(isRetryableError(new Error(message))).toBe(true);
	});

	it('never retries a cancelled execution, even if it otherwise looks transient', () => {
		expect(isRetryableError(new Error('Execution was cancelled while streaming from Langdock.'))).toBe(false);
	});

	it('never retries an explicit API error chunk', () => {
		expect(isRetryableError(new Error('Langdock returned an error while streaming: {"message":"bad request"}'))).toBe(
			false,
		);
	});
});

describe('Retry - withTransientRetries', () => {
	it('does not retry when it succeeds on the first attempt', async () => {
		const operation = jest.fn().mockResolvedValue('ok');
		const sleep = jest.fn().mockResolvedValue(undefined);

		const result = await withTransientRetries(operation, {
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 10,
			maxDelayMs: 1000,
			sleep,
		});

		expect(result).toBe('ok');
		expect(operation).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('retries a retryable error up to maxRetries and then succeeds', async () => {
		const operation = jest
			.fn()
			.mockRejectedValueOnce(new Error('Request failed with status code 503'))
			.mockRejectedValueOnce(new Error('Request failed with status code 503'))
			.mockResolvedValueOnce('ok');
		const sleep = jest.fn().mockResolvedValue(undefined);

		const result = await withTransientRetries(operation, {
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 10,
			maxDelayMs: 1000,
			sleep,
		});

		expect(result).toBe('ok');
		expect(operation).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	it('throws the final error, with retry details attached, once maxRetries is exhausted', async () => {
		const error = new Error('Request failed with status code 429');
		const operation = jest.fn().mockRejectedValue(error);
		const sleep = jest.fn().mockResolvedValue(undefined);

		await expect(
			withTransientRetries(operation, { enabled: true, maxRetries: 2, baseDelayMs: 5, maxDelayMs: 100, sleep }),
		).rejects.toThrow('Request failed with status code 429');

		expect(operation).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
		expect((error as unknown as { langdockRetry?: unknown }).langdockRetry).toEqual({
			statusCode: 429,
			attempts: 3,
			retryable: true,
			errorMessage: 'Request failed with status code 429',
		});
	});

	it('does not retry at all when disabled, even for a retryable error', async () => {
		const operation = jest.fn().mockRejectedValue(new Error('Request failed with status code 503'));
		const sleep = jest.fn().mockResolvedValue(undefined);

		await expect(
			withTransientRetries(operation, { enabled: false, maxRetries: 3, baseDelayMs: 10, maxDelayMs: 1000, sleep }),
		).rejects.toThrow('503');

		expect(operation).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('does not retry a non-retryable error, even when enabled', async () => {
		const operation = jest.fn().mockRejectedValue(new Error('Request failed with status code 400'));
		const sleep = jest.fn().mockResolvedValue(undefined);

		await expect(
			withTransientRetries(operation, { enabled: true, maxRetries: 3, baseDelayMs: 10, maxDelayMs: 1000, sleep }),
		).rejects.toThrow('400');

		expect(operation).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('honours a Retry-After header instead of the exponential backoff delay', async () => {
		const error = {
			message: 'Request failed with status code 429',
			response: { statusCode: 429, headers: { 'retry-after': '2' } },
		};
		const operation = jest.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('ok');
		const sleep = jest.fn().mockResolvedValue(undefined);

		await withTransientRetries(operation, { enabled: true, maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100000, sleep });

		expect(sleep).toHaveBeenCalledWith(2000);
	});
});

describe('Retry - buildErrorItem', () => {
	it('merges the retry details onto the original input item', () => {
		const item = buildErrorItem({ foo: 'bar' }, new Error('Request failed with status code 524'));

		expect(item).toEqual({
			foo: 'bar',
			langdockError: true,
			error: 'Request failed with status code 524',
			statusCode: 524,
			attempts: 1,
			retryable: true,
		});
	});

	it('reads back the attempt count attached by a prior withTransientRetries exhaustion', async () => {
		const operation = jest.fn().mockRejectedValue(new Error('Request failed with status code 502'));
		const sleep = jest.fn().mockResolvedValue(undefined);
		let caught: unknown;

		try {
			await withTransientRetries(operation, { enabled: true, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, sleep });
		} catch (error) {
			caught = error;
		}

		const item = buildErrorItem({}, caught);
		expect(item.attempts).toBe(3);
		expect(item.retryable).toBe(true);
		expect(item.statusCode).toBe(502);
	});
});
