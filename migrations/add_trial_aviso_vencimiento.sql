-- Migration: aviso "tu prueba está por vencer" (día ~3 del trial de 5) del Claim Flow.
-- Modelo vigente: docs/AUTH_AND_ONBOARDING.md.
--
-- Aditiva y retrocompatible: agrega una columna nullable a `suscripcion` que sirve de flag
-- anti-reenvío del scheduler (mientras no sea null, el aviso del trial ya salió). No cambia el
-- comportamiento de las cuentas existentes. Ejecutar en MySQL (prod). Si ya existe, omitir.

ALTER TABLE `suscripcion`
  ADD COLUMN `aviso_trial_vencimiento_at` TIMESTAMP NULL AFTER `fecha_cancelacion`;
