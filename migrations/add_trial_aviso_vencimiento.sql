-- Migration: aviso "tu prueba está por vencer" (día ~12) del Claim Flow. Ver docs/ROADMAP_CLAIM_FLOW.md (Tarea 7)
--
-- Aditiva y retrocompatible: agrega una columna nullable a `suscripcion` que sirve de flag
-- anti-reenvío del scheduler (mientras no sea null, el aviso día-12 ya salió). No cambia el
-- comportamiento de las cuentas existentes. Ejecutar en MySQL (prod). Si ya existe, omitir.

ALTER TABLE `suscripcion`
  ADD COLUMN `aviso_trial_vencimiento_at` TIMESTAMP NULL AFTER `fecha_cancelacion`;
