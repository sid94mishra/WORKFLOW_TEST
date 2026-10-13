// Contract types (spec §3.1) owned by @pulse/shared, re-exported so components import from one place.
export { UPTIME_WINDOWS } from '@pulse/shared';
export type {
  CheckResult,
  CheckStatus,
  MonitorStatus,
  UptimeSummary,
  UptimeWindow,
} from '@pulse/shared';

export type { Monitor, MonitorUpdate } from '@pulse/shared';
export type {
  ActiveMaintenance,
  MaintenanceMonitorIds,
  MaintenanceWindow,
  MaintenanceWindowCreateInput,
  MaintenanceWindowUpdate,
  WeeklyRepeat,
} from '@pulse/shared';
export type {
  Channel,
  ChannelCreateInput,
  ChannelKind,
  ChannelUpdate,
  DeliveryAttempt,
  Incident,
  IncidentStatus,
  IncidentsQuery,
} from './contract';
export type {
  ApiKey,
  ApiKeyCreateInput,
  ApiKeyCreated,
  ApiKeyScope,
  LoginRequest,
  SessionInfo,
  User,
} from './auth-types';
