-- Migration: link de pago por QR sobre recarga_mensajes.
-- Depende de add_packs_recarga_mp.sql (tabla recarga_mensajes ya creada con estado/MP).
-- Habilita pagar una recarga desde otro dispositivo (el celular) escaneando un QR que
-- apunta a /pago/:token, SIN login. El token es de un solo uso y con vencimiento corto.
-- Ejecutar en MySQL (prod). Si algo ya existe, omitir la sentencia que falle.

ALTER TABLE `recarga_mensajes`
  ADD COLUMN `token` VARCHAR(64) NULL,
  ADD COLUMN `token_expira_en` TIMESTAMP NULL;

-- Unicidad del token (MySQL permite múltiples NULL bajo UNIQUE, así que las recargas
-- previas sin token no chocan).
ALTER TABLE `recarga_mensajes`
  ADD UNIQUE KEY `uq_recarga_token` (`token`);
