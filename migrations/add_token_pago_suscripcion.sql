-- Link de pago por WhatsApp para la cuota del plan: token de un solo uso en `pago_suscripcion`
-- para pagar la suscripción desde otro dispositivo (el celular) SIN login, igual que el link de
-- recarga (`recarga_mensajes.token`). Aditiva: no toca datos existentes.
ALTER TABLE `pago_suscripcion`
  ADD COLUMN `token` VARCHAR(64) NULL UNIQUE,
  ADD COLUMN `token_expira_en` TIMESTAMP NULL;
