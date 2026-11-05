-- Defense-in-depth tenant isolation. The API sets `app.org_id` per transaction
-- (SET LOCAL app.org_id = '<uuid>'); the application DB role is subject to these policies.
-- The migration/owner role bypasses RLS (table owner), so migrations & platform jobs still work.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','devices','teams','api_keys','extensions','routing_flows','phone_numbers',
    'port_requests','sip_trunks','blocked_numbers','voicemail_boxes','calls','recordings','voicemails','transcripts',
    'ai_insights','conversations','messages','sms_templates','auto_replies','campaigns','contacts','contact_groups',
    'meetings','subscriptions','usage_records','invoices','webhooks','integrations','audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (
      current_setting('app.bypass_rls', true) = 'on' OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
