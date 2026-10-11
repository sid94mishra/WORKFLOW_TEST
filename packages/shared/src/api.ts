export type ApiData<T> = { data: T };
export type ErrorCode =
  'VALIDATION_ERROR' | 'BAD_REQUEST' | 'NOT_FOUND' | 'UNSUPPORTED_MEDIA_TYPE' | 'INTERNAL_ERROR';
export type ApiIssue = { path: (string | number)[]; message: string; code: string };
export type ApiError = { error: { code: ErrorCode; message: string; issues?: ApiIssue[] } };
export type HealthResponse = { status: 'ok'; version: string; uptimeSeconds: number };
