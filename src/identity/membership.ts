/**
 * identity/membership — the groups a Salesforce user belongs to, as the
 * keys a group connection is bound to: Permission Sets, Public Groups and
 * the Department field. Read through the org connection and cached for
 * a few minutes; nobody maintains a second directory.
 */
import type { Connection } from 'jsforce';
import { logger } from '../logger';

export type GroupKeyType = 'permissionSet' | 'publicGroup' | 'department';

export interface GroupMembership {
  type: GroupKeyType;
  key: string;
  label: string;
}

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; groups: GroupMembership[]; username: string | null }>();

const esc = (s: string) => s.replace(/'/g, "\\'");

export async function membershipFor(conn: Connection, orgId: string, userId: string): Promise<{ groups: GroupMembership[]; username: string | null }> {
  const k = `${orgId}|${userId}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const groups: GroupMembership[] = [];
  let username: string | null = null;
  const id = esc(userId);
  try {
    const [ps, gm, u] = await Promise.all([
      conn.query<{ PermissionSetId: string; PermissionSet: { Name: string; Label: string; IsOwnedByProfile: boolean } }>(
        `SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label, PermissionSet.IsOwnedByProfile FROM PermissionSetAssignment WHERE AssigneeId = '${id}'`,
      ),
      conn.query<{ GroupId: string; Group: { DeveloperName: string; Name: string; Type: string } }>(
        `SELECT GroupId, Group.DeveloperName, Group.Name, Group.Type FROM GroupMember WHERE UserOrGroupId = '${id}'`,
      ),
      conn.query<{ Department: string | null; Username: string }>(`SELECT Department, Username FROM User WHERE Id = '${id}' LIMIT 1`),
    ]);
    for (const r of ps.records) {
      if (r.PermissionSet?.IsOwnedByProfile) continue;
      groups.push({ type: 'permissionSet', key: r.PermissionSetId, label: r.PermissionSet?.Label ?? r.PermissionSet?.Name ?? r.PermissionSetId });
    }
    for (const r of gm.records) {
      if (r.Group?.Type && r.Group.Type !== 'Regular') continue;
      groups.push({ type: 'publicGroup', key: r.GroupId, label: r.Group?.Name ?? r.Group?.DeveloperName ?? r.GroupId });
    }
    const user = u.records[0];
    username = user?.Username ?? null;
    if (user?.Department) groups.push({ type: 'department', key: user.Department, label: user.Department });
  } catch (err) {
    logger.warn({ orgId, userId, err: err instanceof Error ? err.message : err }, 'identity_membership_lookup_failed');
  }
  const entry = { at: Date.now(), groups, username };
  cache.set(k, entry);
  return entry;
}

export function forgetMembership(orgId: string, userId?: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${orgId}|${userId ?? ''}`)) cache.delete(k);
}

/** The groups an admin can bind a connection to, for the dialog. */
export async function listGroups(conn: Connection, type: GroupKeyType): Promise<Array<{ key: string; label: string; members: number | null }>> {
  if (type === 'permissionSet') {
    const r = await conn.query<{ Id: string; Label: string; Name: string }>(
      "SELECT Id, Label, Name FROM PermissionSet WHERE IsOwnedByProfile = false AND IsCustom = true ORDER BY Label LIMIT 200",
    );
    const counts = await conn.query<{ PermissionSetId: string; n: number }>(
      'SELECT PermissionSetId, COUNT(Id) n FROM PermissionSetAssignment GROUP BY PermissionSetId',
    ).catch(() => ({ records: [] as Array<{ PermissionSetId: string; n: number }>, done: true, totalSize: 0 }));
    const byId = new Map(counts.records.map(c => [c.PermissionSetId, Number(c.n)]));
    return r.records.map(p => ({ key: p.Id, label: p.Label || p.Name, members: byId.get(p.Id) ?? 0 }));
  }
  if (type === 'publicGroup') {
    const r = await conn.query<{ Id: string; Name: string }>("SELECT Id, Name FROM Group WHERE Type = 'Regular' ORDER BY Name LIMIT 200");
    const counts = await conn.query<{ GroupId: string; n: number }>('SELECT GroupId, COUNT(Id) n FROM GroupMember GROUP BY GroupId')
      .catch(() => ({ records: [] as Array<{ GroupId: string; n: number }>, done: true, totalSize: 0 }));
    const byId = new Map(counts.records.map(c => [c.GroupId, Number(c.n)]));
    return r.records.map(g => ({ key: g.Id, label: g.Name, members: byId.get(g.Id) ?? 0 }));
  }
  const r = await conn.query<{ Department: string; n: number }>(
    'SELECT Department, COUNT(Id) n FROM User WHERE IsActive = true AND Department != null GROUP BY Department ORDER BY Department LIMIT 200',
  );
  return r.records.map(d => ({ key: d.Department, label: d.Department, members: Number(d.n) }));
}
