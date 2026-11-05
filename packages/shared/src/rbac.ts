/**
 * Role-based access control. Roles are per-organization (membership level), except
 * SUPER_ADMIN which is a platform-operator role.
 */
export const ROLES = [
  'SUPER_ADMIN',
  'COMPANY_OWNER',
  'ADMINISTRATOR',
  'BILLING_ADMIN',
  'MANAGER',
  'SUPERVISOR',
  'AGENT',
  'RECEPTIONIST',
  'EMPLOYEE',
  'READ_ONLY',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'calls:make', 'calls:read:own', 'calls:read:all', 'calls:monitor', 'calls:barge', 'calls:whisper',
  'recordings:read:own', 'recordings:read:all', 'recordings:delete',
  'sms:send', 'sms:bulk', 'sms:read:own', 'sms:read:all',
  'voicemail:read:own', 'voicemail:read:all',
  'contacts:read', 'contacts:write', 'contacts:import',
  'meetings:host', 'meetings:join',
  'chat:use',
  'users:read', 'users:write', 'users:delete',
  'teams:write',
  'numbers:read', 'numbers:write', 'numbers:port',
  'routing:read', 'routing:write',
  'devices:manage', 'sip:manage',
  'billing:read', 'billing:write',
  'analytics:read:team', 'analytics:read:org',
  'audit:read', 'security:manage',
  'webhooks:manage', 'apikeys:manage', 'integrations:manage',
  'ai:use', 'ai:configure',
  'platform:admin',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const BASE_USER: Permission[] = [
  'calls:make', 'calls:read:own', 'recordings:read:own', 'sms:send', 'sms:read:own',
  'voicemail:read:own', 'contacts:read', 'contacts:write', 'meetings:host', 'meetings:join',
  'chat:use', 'users:read', 'numbers:read', 'ai:use',
];

const ADMIN: Permission[] = PERMISSIONS.filter((p) => p !== 'platform:admin');

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  SUPER_ADMIN: new Set(PERMISSIONS),
  COMPANY_OWNER: new Set(ADMIN),
  ADMINISTRATOR: new Set(ADMIN.filter((p) => p !== 'billing:write')),
  BILLING_ADMIN: new Set<Permission>(['billing:read', 'billing:write', 'users:read', 'numbers:read', 'analytics:read:org', 'meetings:join', 'chat:use']),
  MANAGER: new Set<Permission>([
    ...BASE_USER, 'calls:read:all', 'calls:monitor', 'calls:whisper', 'calls:barge',
    'recordings:read:all', 'sms:read:all', 'sms:bulk', 'voicemail:read:all', 'contacts:import',
    'teams:write', 'routing:read', 'analytics:read:team', 'analytics:read:org',
  ]),
  SUPERVISOR: new Set<Permission>([
    ...BASE_USER, 'calls:read:all', 'calls:monitor', 'calls:whisper', 'calls:barge',
    'recordings:read:all', 'voicemail:read:all', 'routing:read', 'analytics:read:team',
  ]),
  AGENT: new Set<Permission>([...BASE_USER]),
  RECEPTIONIST: new Set<Permission>([...BASE_USER, 'calls:read:all', 'voicemail:read:all', 'routing:read']),
  EMPLOYEE: new Set<Permission>([...BASE_USER]),
  READ_ONLY: new Set<Permission>(['calls:read:own', 'contacts:read', 'users:read', 'numbers:read', 'meetings:join']),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function hasAll(role: Role, permissions: Permission[]): boolean {
  return permissions.every((p) => hasPermission(role, p));
}

/** A user may only assign roles at or below their own privilege level. */
const ROLE_RANK: Record<Role, number> = {
  SUPER_ADMIN: 100, COMPANY_OWNER: 90, ADMINISTRATOR: 80, BILLING_ADMIN: 60, MANAGER: 60,
  SUPERVISOR: 50, RECEPTIONIST: 30, AGENT: 30, EMPLOYEE: 20, READ_ONLY: 10,
};
export function canAssignRole(actor: Role, target: Role): boolean {
  if (target === 'SUPER_ADMIN') return actor === 'SUPER_ADMIN';
  return ROLE_RANK[actor] >= ROLE_RANK[target] && hasPermission(actor, 'users:write');
}
