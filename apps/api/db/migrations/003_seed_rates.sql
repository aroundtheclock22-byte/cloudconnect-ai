INSERT INTO rates (prefix, country, per_minute_cents, sms_cents) VALUES
 ('1','US',0,1),('1800','US-TF',2,1),('44','GB',2,4),('447','GB-MOBILE',6,4),('49','DE',2,8),
 ('33','FR',2,7),('91','IN',3,2),('52','MX',3,5),('61','AU',4,6),('81','JP',9,8)
ON CONFLICT (prefix) DO NOTHING;
INSERT INTO coupons (code, percent_off, max_redemptions) VALUES ('LAUNCH20', 20, 1000) ON CONFLICT DO NOTHING;
