import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Db } from '../../common/db.service';
import { EventBus, EventEnvelope } from '../../common/events';
import { config } from '../../config';

export interface SearchHit { type: 'contact' | 'message' | 'call' | 'voicemail'; id: string; title: string; snippet: string; at?: string }

/**
 * Global search. With ELASTICSEARCH_URL set, documents are indexed into per-tenant-filtered
 * indices (cc-messages, cc-transcripts, cc-contacts) and queried with multi_match; otherwise the
 * Postgres fallback runs ILIKE queries (fine for dev/small tenants).
 */
@Injectable()
export class SearchService implements OnModuleInit {
  private log = new Logger('Search');
  private es = config().ELASTICSEARCH_URL;
  constructor(private db: Db, private bus: EventBus) {}

  onModuleInit() {
    if (!this.es) return;
    this.bus.on('event', (e: EventEnvelope) => this.onEvent(e).catch((err) => this.log.warn(`index failed: ${err.message}`)));
  }

  private async esReq(method: string, path: string, body?: object) {
    const res = await fetch(`${this.es}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`ES ${method} ${path}: ${res.status}`);
    return res.json() as Promise<any>;
  }

  private async onEvent(e: EventEnvelope) {
    if (e.type === 'message.received' || e.type === 'message.sent') {
      const m = await this.db.one(`SELECT id, org_id, conversation_id, body, from_address, created_at FROM messages WHERE id=$1`, [e.data.messageId]);
      if (m) await this.esReq('PUT', `/cc-messages/_doc/${m.id}`, { org_id: m.org_id, conversation_id: m.conversation_id, body: m.body, from: m.from_address, at: m.created_at });
    } else if (e.type === 'call.analyzed') {
      const t = await this.db.one(`SELECT t.source_id, t.org_id, t.full_text, i.summary, i.keywords, c.started_at FROM transcripts t JOIN ai_insights i ON i.source_id=t.source_id JOIN calls c ON c.id=t.source_id WHERE t.source_type='call' AND t.source_id=$1`, [e.data.callId]);
      if (t) await this.esReq('PUT', `/cc-transcripts/_doc/${t.source_id}`, { org_id: t.org_id, text: t.full_text, summary: t.summary, keywords: t.keywords, at: t.started_at });
    }
  }

  async search(orgId: string, userId: string | null, q: string, limit = 20): Promise<SearchHit[]> {
    q = q.trim().slice(0, 200);
    if (q.length < 2) return [];
    if (this.es) {
      try {
        const r = await this.esReq('POST', '/cc-messages,cc-transcripts/_search', {
          size: limit, query: { bool: { filter: [{ term: { org_id: orgId } }], must: [{ multi_match: { query: q, fields: ['body', 'text', 'summary^2', 'keywords^3'], fuzziness: 'AUTO' } }] } },
          highlight: { fields: { body: {}, text: {}, summary: {} } },
        });
        return r.hits.hits.map((h: any) => ({ type: h._index.startsWith('cc-messages') ? 'message' : 'call', id: h._id, title: h._source.from ?? 'Call transcript',
          snippet: Object.values(h.highlight ?? {}).flat()[0] as string ?? (h._source.body ?? h._source.summary ?? '').slice(0, 160), at: h._source.at }));
      } catch (e) { this.log.warn(`ES search failed, falling back: ${(e as Error).message}`); }
    }
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const [contacts, messages, calls, vms] = await Promise.all([
      this.db.query(`SELECT id, first_name || ' ' || last_name title, COALESCE(company, phones[1], '') snippet FROM contacts WHERE org_id=$1 AND (owner_id IS NULL OR owner_id=$2)
        AND (first_name || ' ' || last_name || ' ' || COALESCE(company,'') || ' ' || array_to_string(phones,' ') || ' ' || array_to_string(emails,' ')) ILIKE $3 LIMIT $4`, [orgId, userId, like, limit]),
      this.db.query(`SELECT id, from_address title, body snippet, created_at at FROM messages WHERE org_id=$1 AND body ILIKE $2 ORDER BY created_at DESC LIMIT $3`, [orgId, like, limit]),
      this.db.query(`SELECT i.source_id id, 'Call summary' title, i.summary snippet, i.created_at at FROM ai_insights i WHERE i.org_id=$1 AND i.source_type='call' AND (i.summary ILIKE $2 OR $4 = ANY(i.keywords)) ORDER BY i.created_at DESC LIMIT $3`, [orgId, like, limit, q.toLowerCase()]),
      this.db.query(`SELECT id, from_number title, COALESCE(ai_summary, transcript) snippet, created_at at FROM voicemails WHERE org_id=$1 AND (transcript ILIKE $2 OR ai_summary ILIKE $2) LIMIT $3`, [orgId, like, limit]),
    ]);
    return [
      ...contacts.map((r) => ({ type: 'contact' as const, ...r })), ...calls.map((r) => ({ type: 'call' as const, ...r })),
      ...vms.map((r) => ({ type: 'voicemail' as const, ...r })), ...messages.map((r) => ({ type: 'message' as const, ...r })),
    ].slice(0, limit);
  }
}
