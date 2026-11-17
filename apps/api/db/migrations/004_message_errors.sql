-- Carrier delivery errors (e.g. Twilio 30034 = number not registered for US A2P 10DLC) so the UI can explain failures.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS error_message text;
