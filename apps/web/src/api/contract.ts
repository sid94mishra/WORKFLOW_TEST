import { CHANNEL_KINDS, CHANNEL_LIMITS } from '@pulse/shared';

export { CHANNEL_KINDS, CHANNEL_LIMITS, formatDuration } from '@pulse/shared';
export type {
  Channel,
  ChannelCreateInput,
  ChannelKind,
  ChannelUpdate,
  DeliveryAttempt,
  Incident,
  IncidentStatus,
  IncidentsQuery,
} from '@pulse/shared';

export interface ValidationIssue {
  path: (string | number)[];
  message: string;
}

/** Client-side mirror of ChannelCreateSchema / ChannelUpdateSchema field rules. */
export function validateChannelFields(v: { name?: string; url?: string }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (v.name !== undefined) {
    const name = v.name.trim();
    if (name.length === 0) issues.push({ path: ['name'], message: 'Name is required' });
    else if (name.length > CHANNEL_LIMITS.nameMaxLength)
      issues.push({
        path: ['name'],
        message: `Name must be at most ${CHANNEL_LIMITS.nameMaxLength} characters`,
      });
  }
  if (v.url !== undefined) {
    let ok = false;
    try {
      new URL(v.url);
      ok = /^https?:\/\//i.test(v.url);
    } catch {
      ok = false;
    }
    if (v.url.length > CHANNEL_LIMITS.urlMaxLength)
      issues.push({ path: ['url'], message: 'URL is too long' });
    else if (!ok) issues.push({ path: ['url'], message: 'Enter a valid http or https URL' });
  }
  return issues;
}
