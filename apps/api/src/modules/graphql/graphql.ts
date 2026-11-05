/**
 * GraphQL API (served at /graphql). Shares authentication, tenancy and RBAC with REST.
 */
import { buildSchema, GraphQLError, parse, specifiedRules, validate, ValidationContext } from 'graphql';
import { createHandler } from 'graphql-http/lib/use/express';
import { Request } from 'express';
import { hasPermission, Permission } from '@cloudconnect/shared';
import { authenticate, AuthUser } from '../../common/auth';
import { Db } from '../../common/db.service';

export const typeDefs = /* GraphQL */ `
  type User { id: ID! email: String! firstName: String! lastName: String! role: String! presence: String! extension: String department: String }
  type PhoneNumber { id: ID! e164: String! type: String! country: String! label: String assignedUserId: ID }
  type AiInsight { summary: String sentiment: String callScore: Int keywords: [String!]! }
  type Call { id: ID! direction: String! status: String! from: String! to: String! startedAt: String! durationSeconds: Int! user: User insight: AiInsight }
  type Contact { id: ID! firstName: String! lastName: String! company: String phones: [String!]! emails: [String!]! tags: [String!]! favorite: Boolean! }
  type Conversation { id: ID! kind: String! participants: [String!]! lastMessageAt: String! messages(limit: Int = 50): [Message!]! }
  type Message { id: ID! direction: String! status: String! from: String! body: String! createdAt: String! }
  type Meeting { id: ID! title: String! joinCode: String! scheduledStart: String mode: String! }
  type Voicemail { id: ID! from: String! durationSeconds: Int! transcript: String aiSummary: String isRead: Boolean! createdAt: String! }
  type CallStats { total: Int! answered: Int! missed: Int! avgDuration: Int! }
  type Query {
    me: User!
    users(search: String, limit: Int = 50): [User!]!
    numbers: [PhoneNumber!]!
    calls(limit: Int = 25, direction: String): [Call!]!
    call(id: ID!): Call
    contacts(search: String, limit: Int = 50): [Contact!]!
    conversations(limit: Int = 25): [Conversation!]!
    meetings(limit: Int = 25): [Meeting!]!
    voicemails(limit: Int = 25): [Voicemail!]!
    callStats(days: Int = 7): CallStats!
  }
  type Mutation {
    setPresence(status: String!, note: String): User!
    createContact(firstName: String!, lastName: String, phones: [String!], emails: [String!], tags: [String!]): Contact!
    markVoicemailRead(id: ID!, isRead: Boolean!): Voicemail
  }
`;
export const schema = buildSchema(typeDefs);

const clamp = (n: number | undefined, d: number) => Math.min(Math.max(n ?? d, 1), 200);

export function graphqlHandler(db: Db) {
  const need = (u: AuthUser, p: Permission) => { if (!hasPermission(u.role, p)) throw new GraphQLError(`Missing permission ${p}`, { extensions: { code: 'FORBIDDEN' } }); };
  const userCols = `u.id, u.email, u.first_name "firstName", u.last_name "lastName", u.role, u.presence, u.department, e.number extension`;
  const userJoin = `FROM users u LEFT JOIN extensions e ON e.user_id=u.id AND e.kind='user'`;

  const root = (u: AuthUser) => ({
    me: () => db.one(`SELECT ${userCols} ${userJoin} WHERE u.id=$1`, [u.userId]),
    users: ({ search, limit }: any) => { need(u, 'users:read'); return db.query(`SELECT ${userCols} ${userJoin} WHERE u.org_id=$1 AND u.deleted_at IS NULL AND ($2::text IS NULL OR u.first_name || ' ' || u.last_name ILIKE '%'||$2||'%') ORDER BY u.first_name LIMIT $3`, [u.orgId, search ?? null, clamp(limit, 50)]); },
    numbers: () => { need(u, 'numbers:read'); return db.query(`SELECT id, e164, type, country, label, assigned_user_id "assignedUserId" FROM phone_numbers WHERE org_id=$1 AND status='active'`, [u.orgId]); },
    calls: async ({ limit, direction }: any) => {
      need(u, 'calls:read:own');
      const all = hasPermission(u.role, 'calls:read:all');
      const rows = await db.query(`SELECT c.id, c.direction, c.status, c.from_number "from", c.to_number "to", c.started_at "startedAt", c.duration_seconds "durationSeconds", c.user_id FROM calls c WHERE c.org_id=$1 AND ($2 OR c.user_id=$3) AND ($4::text IS NULL OR c.direction::text=$4) ORDER BY c.started_at DESC LIMIT $5`,
        [u.orgId, all, u.userId, direction ?? null, clamp(limit, 25)]);
      return rows.map(callResolvers);
    },
    call: async ({ id }: any) => {
      need(u, 'calls:read:own');
      const c = await db.one(`SELECT c.id, c.direction, c.status, c.from_number "from", c.to_number "to", c.started_at "startedAt", c.duration_seconds "durationSeconds", c.user_id FROM calls c WHERE c.id=$1 AND c.org_id=$2 AND ($3 OR c.user_id=$4)`, [id, u.orgId, hasPermission(u.role, 'calls:read:all'), u.userId]);
      return c ? callResolvers(c) : null;
    },
    contacts: ({ search, limit }: any) => { need(u, 'contacts:read'); return db.query(`SELECT id, first_name "firstName", last_name "lastName", company, phones, emails, tags, favorite FROM contacts WHERE org_id=$1 AND (owner_id IS NULL OR owner_id=$2) AND ($3::text IS NULL OR first_name || ' ' || last_name ILIKE '%'||$3||'%') ORDER BY first_name LIMIT $4`, [u.orgId, u.userId, search ?? null, clamp(limit, 50)]); },
    conversations: async ({ limit }: any) => {
      need(u, 'sms:read:own');
      const rows = await db.query(`SELECT c.id, c.kind, c.participants, c.last_message_at "lastMessageAt" FROM conversations c LEFT JOIN phone_numbers n ON n.id=c.phone_number_id
        WHERE c.org_id=$1 AND (($2::text = ANY(c.participants)) OR (c.kind IN ('sms','group_sms') AND ($3 OR n.assigned_user_id=$2::uuid OR n.assigned_user_id IS NULL))) ORDER BY c.last_message_at DESC LIMIT $4`, [u.orgId, u.userId, hasPermission(u.role, 'sms:read:all'), clamp(limit, 25)]);
      return rows.map((c) => ({ ...c, messages: ({ limit: l }: any) => db.query(`SELECT id, direction, status, from_address "from", body, created_at "createdAt" FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT $2`, [c.id, clamp(l, 50)]) }));
    },
    meetings: ({ limit }: any) => { need(u, 'meetings:join'); return db.query(`SELECT id, title, join_code "joinCode", scheduled_start "scheduledStart", mode FROM meetings WHERE org_id=$1 AND host_id=$2 ORDER BY created_at DESC LIMIT $3`, [u.orgId, u.userId, clamp(limit, 25)]); },
    voicemails: ({ limit }: any) => { need(u, 'voicemail:read:own'); return db.query(`SELECT v.id, v.from_number "from", v.duration_seconds "durationSeconds", v.transcript, v.ai_summary "aiSummary", v.is_read "isRead", v.created_at "createdAt" FROM voicemails v JOIN voicemail_boxes b ON b.id=v.mailbox_id WHERE v.org_id=$1 AND (b.user_id=$2 OR $3) ORDER BY v.created_at DESC LIMIT $4`, [u.orgId, u.userId, hasPermission(u.role, 'voicemail:read:all'), clamp(limit, 25)]); },
    callStats: ({ days }: any) => { need(u, 'calls:read:own'); return db.one(`SELECT count(*)::int total, count(*) FILTER (WHERE answered_at IS NOT NULL)::int answered, count(*) FILTER (WHERE direction='inbound' AND answered_at IS NULL)::int missed, COALESCE(avg(duration_seconds) FILTER (WHERE answered_at IS NOT NULL),0)::int "avgDuration" FROM calls WHERE org_id=$1 AND started_at > now() - make_interval(days => $2) AND ($3 OR user_id=$4)`, [u.orgId, Math.min(days ?? 7, 365), hasPermission(u.role, 'calls:read:all'), u.userId]); },
    setPresence: async ({ status, note }: any) => {
      if (!['available', 'busy', 'on_call', 'in_meeting', 'away', 'dnd', 'offline'].includes(status)) throw new GraphQLError('invalid status');
      await db.query(`UPDATE users SET presence=$2, presence_note=$3 WHERE id=$1`, [u.userId, status, note ?? null]);
      return db.one(`SELECT ${userCols} ${userJoin} WHERE u.id=$1`, [u.userId]);
    },
    createContact: ({ firstName, lastName, phones, emails, tags }: any) => { need(u, 'contacts:write'); return db.one(`INSERT INTO contacts (org_id, owner_id, first_name, last_name, phones, emails, tags) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, first_name "firstName", last_name "lastName", company, phones, emails, tags, favorite`, [u.orgId, u.userId, firstName, lastName ?? '', phones ?? [], emails ?? [], tags ?? []]); },
    markVoicemailRead: ({ id, isRead }: any) => db.one(`UPDATE voicemails v SET is_read=$3 FROM voicemail_boxes b WHERE b.id=v.mailbox_id AND v.id=$1 AND v.org_id=$2 AND (b.user_id=$4 OR $5) RETURNING v.id, v.from_number "from", v.duration_seconds "durationSeconds", v.transcript, v.ai_summary "aiSummary", v.is_read "isRead", v.created_at "createdAt"`, [id, u.orgId, isRead, u.userId, hasPermission(u.role, 'voicemail:read:all')]),
  });

  const callResolvers = (c: any) => ({
    ...c,
    user: () => c.user_id ? db.one(`SELECT ${userCols} ${userJoin} WHERE u.id=$1`, [c.user_id]) : null,
    insight: () => db.one(`SELECT summary, sentiment, call_score "callScore", keywords FROM ai_insights WHERE source_type='call' AND source_id=$1`, [c.id]),
  });

  const unauthorized = (msg: string, status = 401) => [JSON.stringify({ errors: [{ message: msg }] }), { status, statusText: msg, headers: { 'content-type': 'application/json' } }] as const;

  return createHandler({
    schema,
    async onSubscribe(req, params) {
      const user = await authenticate(db, (req.raw as Request).headers.authorization);
      if (!user) return unauthorized('Unauthorized') as any;
      if (params.query.length > 10_000) return unauthorized('Query too large', 413) as any;
      let document;
      try { document = parse(params.query); } catch (e) { return [JSON.stringify({ errors: [{ message: (e as Error).message }] }), { status: 400, statusText: 'Bad Request', headers: { 'content-type': 'application/json' } }] as any; }
      const errors = validate(schema, document, [...specifiedRules, depthLimit(6)]);
      if (errors.length) return [JSON.stringify({ errors: errors.map((e) => ({ message: e.message })) }), { status: 400, statusText: 'Bad Request', headers: { 'content-type': 'application/json' } }] as any;
      return { schema, document, variableValues: params.variables, operationName: params.operationName, rootValue: root(user), contextValue: { user } };
    },
  });
}

/** Rejects queries nested deeper than `max` selection levels (DoS protection). */
function depthLimit(max: number) {
  return (ctx: ValidationContext) => {
    const check = (sel: any, depth: number) => {
      if (depth > max) { ctx.reportError(new GraphQLError(`Query depth exceeds ${max}`)); return; }
      for (const s of sel?.selections ?? []) if (s.selectionSet) check(s.selectionSet, depth + 1);
    };
    return { OperationDefinition(node: any) { check(node.selectionSet, 1); } };
  };
}
