import type { FastifyReply } from 'fastify';
import type { ApiIssue, ErrorCode } from '@pulse/shared';
import type { ZodError } from 'zod';

/** Maps zod issues to the API's `ApiIssue` shape (array indices stay numbers). */
export function issues(error: ZodError): ApiIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((key) => (typeof key === 'number' ? key : String(key))),
    message: issue.message,
    code: issue.code,
  }));
}

export function apiError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
  validationIssues?: ApiIssue[],
) {
  const error = validationIssues ? { code, message, issues: validationIssues } : { code, message };
  return reply.code(status).type('application/json; charset=utf-8').send({ error });
}
