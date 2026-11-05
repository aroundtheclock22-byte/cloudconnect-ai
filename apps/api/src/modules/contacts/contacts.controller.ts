import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { normalizeE164 } from '@cloudconnect/shared';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth';
import { Db } from '../../common/db.service';
import { page, z$ } from '../../common/validation';

const Contact = z.object({ firstName: z.string().max(80).default(''), lastName: z.string().max(80).default(''), company: z.string().max(120).optional(), emails: z.array(z.string().email()).default([]),
  phones: z.array(z.string()).default([]), tags: z.array(z.string().max(40)).default([]), favorite: z.boolean().default(false), notes: z.string().max(5000).optional(), shared: z.boolean().default(false) });
const Group = z.object({ name: z.string().min(1).max(80), contactIds: z.array(z.string().uuid()).default([]) });

const COLS = `id, first_name "firstName", last_name "lastName", company, emails, phones, tags, favorite, notes, owner_id "ownerId", crm_source "crmSource", created_at "createdAt"`;

/** RFC-4180-ish CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}
/** CSV cell with formula-injection protection (OWASP); plain E.164 numbers are left untouched. */
const csvCell = (v: unknown) => {
  const s = Array.isArray(v) ? v.join(';') : String(v ?? '');
  const risky = /^[=+\-@\t\r]/.test(s) && !/^\+[\d;+]+$/.test(s);
  return /[",\n;]/.test(s) || risky ? `"${(risky ? "'" : '') + s.replace(/"/g, '""')}"` : s;
};

@ApiTags('contacts')
@Controller('v1/contacts')
export class ContactsController {
  constructor(private db: Db) {}

  private norm(b: z.infer<typeof Contact>) {
    return { ...b, phones: [...new Set(b.phones.map((p) => normalizeE164(p)).filter((p): p is string => !!p))], emails: [...new Set(b.emails.map((e) => e.toLowerCase()))] };
  }

  @RequirePermissions('contacts:read') @Get()
  async list(@CurrentUser() u: AuthUser, @Query() q: { q?: string; tag?: string; favorite?: string; limit?: string; offset?: string }) {
    const { limit, offset } = page(q);
    const rows = await this.db.query(`SELECT ${COLS}, count(*) OVER() total FROM contacts WHERE org_id=$1 AND (owner_id IS NULL OR owner_id=$2)
      AND ($3::text IS NULL OR (first_name || ' ' || last_name || ' ' || COALESCE(company,'') || ' ' || array_to_string(phones,' ') || ' ' || array_to_string(emails,' ')) ILIKE '%' || $3 || '%')
      AND ($4::text IS NULL OR $4 = ANY(tags)) AND ($5::boolean IS NOT TRUE OR favorite) ORDER BY favorite DESC, first_name, last_name LIMIT $6 OFFSET $7`,
      [u.orgId, u.userId, q.q ?? null, q.tag ?? null, q.favorite === 'true', limit, offset]);
    return { data: rows.map(({ total, ...r }) => r), total: Number(rows[0]?.total ?? 0), limit, offset };
  }

  @RequirePermissions('contacts:read') @Get('lookup')
  lookup(@CurrentUser() u: AuthUser, @Query('phone') phone: string) {
    const e = normalizeE164(phone ?? '');
    return e ? this.db.one(`SELECT ${COLS} FROM contacts WHERE org_id=$1 AND (owner_id IS NULL OR owner_id=$2) AND $3 = ANY(phones) LIMIT 1`, [u.orgId, u.userId, e]).then((r) => r ?? null) : null;
  }

  /** Duplicate detection: contacts sharing a phone number or email. */
  @RequirePermissions('contacts:read') @Get('duplicates')
  duplicates(@CurrentUser() u: AuthUser) {
    return this.db.query(`WITH keys AS (
        SELECT id, unnest(phones) k FROM contacts WHERE org_id=$1 AND (owner_id IS NULL OR owner_id=$2)
        UNION ALL SELECT id, unnest(emails)::text FROM contacts WHERE org_id=$1 AND (owner_id IS NULL OR owner_id=$2))
      SELECT k "matchKey", array_agg(DISTINCT id) "contactIds" FROM keys GROUP BY k HAVING count(DISTINCT id) > 1 ORDER BY k`, [u.orgId, u.userId]);
  }

  @RequirePermissions('contacts:write') @HttpCode(200) @Post('merge')
  async merge(@CurrentUser() u: AuthUser, @Body() b: { primaryId: string; duplicateIds: string[] }) {
    if (!b?.primaryId || !b.duplicateIds?.length) throw new BadRequestException('primaryId and duplicateIds required');
    return this.db.tx(u.orgId, async (c) => {
      const dupes = (await c.query(`SELECT * FROM contacts WHERE org_id=$1 AND id = ANY($2::uuid[]) AND id <> $3`, [u.orgId, b.duplicateIds, b.primaryId])).rows;
      const r = await c.query(`UPDATE contacts SET phones = ARRAY(SELECT DISTINCT unnest(phones || $3::text[])), emails = ARRAY(SELECT DISTINCT unnest(emails || $4::citext[])), tags = ARRAY(SELECT DISTINCT unnest(tags || $5::text[])), updated_at=now()
        WHERE id=$1 AND org_id=$2 RETURNING ${COLS}`, [b.primaryId, u.orgId, dupes.flatMap((d) => d.phones), dupes.flatMap((d) => d.emails), dupes.flatMap((d) => d.tags)]);
      if (!r.rows[0]) throw new NotFoundException();
      await c.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [dupes.map((d) => d.id)]);
      return { ...r.rows[0], merged: dupes.length };
    });
  }

  @RequirePermissions('contacts:write') @Post()
  create(@CurrentUser() u: AuthUser, @Body(z$(Contact)) raw: z.infer<typeof Contact>) {
    const b = this.norm(raw);
    return this.db.one(`INSERT INTO contacts (org_id, owner_id, first_name, last_name, company, emails, phones, tags, favorite, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
      [u.orgId, b.shared ? null : u.userId, b.firstName, b.lastName, b.company ?? null, b.emails, b.phones, b.tags, b.favorite, b.notes ?? null]);
  }

  @RequirePermissions('contacts:write') @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(z$(Contact.partial())) raw: Partial<z.infer<typeof Contact>>) {
    const b = { ...raw, ...(raw.phones ? { phones: this.norm({ ...(raw as any), phones: raw.phones, emails: [] }).phones } : {}) };
    const r = await this.db.one(`UPDATE contacts SET first_name=COALESCE($4,first_name), last_name=COALESCE($5,last_name), company=COALESCE($6,company), emails=COALESCE($7,emails), phones=COALESCE($8,phones),
      tags=COALESCE($9,tags), favorite=COALESCE($10,favorite), notes=COALESCE($11,notes), updated_at=now() WHERE id=$1 AND org_id=$2 AND (owner_id IS NULL OR owner_id=$3) RETURNING ${COLS}`,
      [id, u.orgId, u.userId, b.firstName ?? null, b.lastName ?? null, b.company ?? null, b.emails ?? null, b.phones ?? null, b.tags ?? null, b.favorite ?? null, b.notes ?? null]);
    if (!r) throw new NotFoundException();
    return r;
  }

  @RequirePermissions('contacts:write') @HttpCode(204) @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) { await this.db.query(`DELETE FROM contacts WHERE id=$1 AND org_id=$2 AND (owner_id IS NULL OR owner_id=$3)`, [id, u.orgId, u.userId]); }

  /** CSV import. Header row required; recognized columns: first_name,last_name,company,email,phone,tags. */
  @RequirePermissions('contacts:import') @HttpCode(200) @Post('import')
  async import(@CurrentUser() u: AuthUser, @Body() b: { csv: string; shared?: boolean; skipDuplicates?: boolean }) {
    const rows = parseCsv(String(b?.csv ?? ''));
    if (rows.length < 2) throw new BadRequestException('CSV must contain a header row and at least one contact');
    if (rows.length > 50_001) throw new BadRequestException('Max 50,000 contacts per import');
    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const col = (names: string[]) => header.findIndex((h) => names.includes(h));
    const ix = { first: col(['first_name', 'firstname', 'first', 'given_name']), last: col(['last_name', 'lastname', 'last', 'surname']), company: col(['company', 'organization']),
      email: col(['email', 'email_address', 'e-mail']), phone: col(['phone', 'phone_number', 'mobile', 'telephone']), tags: col(['tags', 'labels']) };
    const existing = b.skipDuplicates !== false ? new Set((await this.db.query(`SELECT unnest(phones) k FROM contacts WHERE org_id=$1 UNION SELECT unnest(emails)::text FROM contacts WHERE org_id=$1`, [u.orgId])).map((r) => r.k)) : new Set<string>();
    let imported = 0, skipped = 0, invalid = 0;
    await this.db.tx(u.orgId, async (c) => {
      for (const r of rows.slice(1)) {
        const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
        const phone = get(ix.phone) ? normalizeE164(get(ix.phone)) : null;
        const email = get(ix.email).toLowerCase();
        if (!phone && !email && !get(ix.first)) { invalid++; continue; }
        if ((phone && existing.has(phone)) || (email && existing.has(email))) { skipped++; continue; }
        await c.query(`INSERT INTO contacts (org_id, owner_id, first_name, last_name, company, emails, phones, tags, crm_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'csv')`,
          [u.orgId, b.shared ? null : u.userId, get(ix.first), get(ix.last), get(ix.company) || null, email ? [email] : [], phone ? [phone] : [], get(ix.tags) ? get(ix.tags).split(/[;|]/).map((t) => t.trim()).filter(Boolean) : []]);
        if (phone) existing.add(phone); if (email) existing.add(email);
        imported++;
      }
    });
    return { imported, skipped, invalid };
  }

  @RequirePermissions('contacts:read') @Get('export.csv') @Header('Content-Type', 'text/csv') @Header('Content-Disposition', 'attachment; filename="contacts.csv"')
  async export(@CurrentUser() u: AuthUser) {
    const rows = await this.db.query(`SELECT first_name, last_name, company, emails, phones, tags, favorite FROM contacts WHERE org_id=$1 AND (owner_id IS NULL OR owner_id=$2) ORDER BY first_name`, [u.orgId, u.userId]);
    return ['first_name,last_name,company,email,phone,tags,favorite', ...rows.map((r) => [r.first_name, r.last_name, r.company, r.emails, r.phones, r.tags, r.favorite].map(csvCell).join(','))].join('\n');
  }

  @RequirePermissions('contacts:read') @Get('groups')
  groups(@CurrentUser() u: AuthUser) { return this.db.query(`SELECT id, name, contact_ids "contactIds", cardinality(contact_ids) size FROM contact_groups WHERE org_id=$1 ORDER BY name`, [u.orgId]); }
  @RequirePermissions('contacts:write') @Post('groups')
  createGroup(@CurrentUser() u: AuthUser, @Body(z$(Group)) b: z.infer<typeof Group>) {
    return this.db.one(`INSERT INTO contact_groups (org_id, name, contact_ids) VALUES ($1,$2, ARRAY(SELECT id FROM contacts WHERE org_id=$1 AND id = ANY($3::uuid[]))) ON CONFLICT (org_id, name) DO UPDATE SET contact_ids=EXCLUDED.contact_ids RETURNING id, name, contact_ids "contactIds"`,
      [u.orgId, b.name, b.contactIds]);
  }
}
