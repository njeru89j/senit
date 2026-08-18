import { HttpErrorResponse } from '@angular/common/http';

export interface ApiErrorPayload {
  message?: string | string[];
  error?: string;
  details?: string[];
}

export function getApiErrorMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) {
    return error instanceof Error ? error.message : 'An unexpected error occurred.';
  }

  if (error.status === 0) {
    return 'Cannot reach the SendIT API. Check that the server is running and try again.';
  }

  const payload = error.error as ApiErrorPayload | string | null;
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.message)) return payload.message.join('. ');
    if (payload.message) return payload.message;
    if (payload.details?.length) return payload.details.join('. ');
  }

  const defaults: Record<number, string> = {
    400: 'Please check the information you entered.',
    401: 'Your session has expired. Please log in again.',
    403: 'You do not have permission to perform this action.',
    404: 'The requested item was not found.',
    409: 'This action conflicts with an existing record.',
    422: 'Please correct the highlighted information.',
    429: 'Too many requests. Please wait and try again.',
    500: 'The server could not complete this request. Please try again.',
  };
  return defaults[error.status] ?? `Request failed (${error.status}). Please try again.`;
}
