ALTER TABLE restaurante
  ADD COLUMN whatsapp_waba_id VARCHAR(100) NULL,
  ADD COLUMN whatsapp_access_token VARCHAR(512) NULL,
  ADD COLUMN whatsapp_token_expiry TIMESTAMP NULL;
