import type { IDataObject } from 'n8n-workflow';

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504, 524]);

// Matched (lower-cased, substring) against error messages that carry no
// HTTP status code of their own - specifically the errors StreamTransport.ts
// throws for a connection that never completed. Kept in sync with the exact
// wording there.
const RETRYABLE_STREAM_MESSAGES = [
	'ended before a finish',
	'connection closed early',
	'stream connection error',
	'did not complete within the configured timeout',
];

export interface RetryErrorDetails {
	statusCode?: number;
	attempts: number;
	retryable: boolean;
	errorMessage: string;
}

export interface RetryOptions {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	sleep?: (delayMs: number) => Promise<void>;
}

export class LangdockRetryError extends Error {
	statusCode?: number;

	attempts: number;

	retryable: boolean;

	originalError: unknown;

	constructor(error: unknown, details: RetryErrorDetails) {
		super(details.errorMessage);
		this.name = 'LangdockRetryError';
		this.statusCode = details.statusCode;
		this.attempts = details.attempts;
		this.retryable = details.retryable;
		this.originalError = error;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	const record = asRecord(error);
	if (typeof record?.message === 'string') return record.message;
	return String(error);
}

export function getStatusCode(error: unknown): number | undefined {
	const record = asRecord(error);
	const response = asRecord(record?.response);
	const candidates = [record?.statusCode, record?.httpCode, record?.status, response?.statusCode];

	for (const candidate of candidates) {
		const numeric = typeof candidate === 'number' ? candidate : Number(candidate);
		if (Number.isInteger(numeric) && numeric >= 100 && numeric <= 599) return numeric;
	}

	const match = getErrorMessage(error).match(/\b(408|429|502|503|504|524)\b/);
	return match ? Number(match[1]) : undefined;
}

export function isRetryableError(error: unknown): boolean {
	const statusCode = getStatusCode(error);
	if (statusCode !== undefined) return RETRYABLE_STATUS_CODES.has(statusCode);

	const message = getErrorMessage(error).toLowerCase();
	if (message.includes('cancelled') || message.includes('canceled')) return false;
	if (message.includes('returned an error while streaming')) return false;

	return RETRYABLE_STREAM_MESSAGES.some((part) => message.includes(part));
}

function getRetryAfterMs(error: unknown): number | undefined {
	const record = asRecord(error);
	const response = asRecord(record?.response);
	const headers = asRecord(response?.headers) ?? asRecord(record?.headers);
	if (!headers) return undefined;

	const raw = headers['retry-after'] ?? headers['Retry-After'];
	if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, raw * 1000);
	if (typeof raw !== 'string' || !raw.trim()) return undefined;

	const seconds = Number(raw);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

	const dateMs = Date.parse(raw);
	return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function defaultSleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function attachDetails(error: unknown, details: RetryErrorDetails): void {
	const record = asRecord(error);
	if (record) {
		record.langdockRetry = details;
	}
}

export function getRetryErrorDetails(error: unknown): RetryErrorDetails {
	if (error instanceof LangdockRetryError) {
		return {
			statusCode: error.statusCode,
			attempts: error.attempts,
			retryable: error.retryable,
			errorMessage: error.message,
		};
	}

	const record = asRecord(error);
	const attached = asRecord(record?.langdockRetry);
	if (attached && typeof attached.attempts === 'number' && typeof attached.retryable === 'boolean') {
		return {
			statusCode: typeof attached.statusCode === 'number' ? attached.statusCode : undefined,
			attempts: attached.attempts,
			retryable: attached.retryable,
			errorMessage: typeof attached.errorMessage === 'string' ? attached.errorMessage : getErrorMessage(error),
		};
	}

	return {
		statusCode: getStatusCode(error),
		attempts: 1,
		retryable: isRetryableError(error),
		errorMessage: getErrorMessage(error),
	};
}

/**
 * Runs `operation`, retrying with exponential backoff (+ jitter, honouring a
 * Retry-After header when present) on transient errors: HTTP 408/429/502/503/504/524,
 * or a stream that never completed. Never retries a cancelled execution or an
 * explicit API error chunk. On final failure, attaches the retry details onto
 * the thrown error (read back later by getRetryErrorDetails/buildErrorItem).
 */
export async function withTransientRetries<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
	const maxRetries = Math.max(0, Math.min(10, Math.round(options.maxRetries)));
	const sleep = options.sleep ?? defaultSleep;
	let attempts = 0;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		attempts += 1;
		try {
			return await operation();
		} catch (error) {
			const retryable = isRetryableError(error);
			const details: RetryErrorDetails = {
				statusCode: getStatusCode(error),
				attempts,
				retryable,
				errorMessage: getErrorMessage(error),
			};

			if (!options.enabled || !retryable || attempts > maxRetries) {
				attachDetails(error, details);
				throw error;
			}

			const exponentialDelay = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempts - 1));
			const retryAfter = getRetryAfterMs(error);
			const jitter = Math.floor(Math.random() * Math.max(1, Math.min(1000, exponentialDelay * 0.1)));

			await sleep(Math.min(options.maxDelayMs, retryAfter ?? exponentialDelay + jitter));
		}
	}
}

export function buildErrorItem(input: IDataObject, error: unknown): IDataObject {
	const details = getRetryErrorDetails(error);
	return {
		...input,
		langdockError: true,
		error: details.errorMessage,
		statusCode: details.statusCode,
		attempts: details.attempts,
		retryable: details.retryable,
	};
}
