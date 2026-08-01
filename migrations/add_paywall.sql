-- Migration: hard paywall de suscripción.
-- Agrega restaurante.requiere_suscripcion: los locales nuevos (dados de alta bajo el modelo
-- de planes) requieren una suscripción activa para usar el panel. Las cuentas existentes
-- quedan en default=false → grandfathered (nunca bloqueadas) hasta el backfill (tarea 2.4).
-- Aditivo y retrocompatible: los admins viejos ignoran la columna.
-- ⚠️ Correr ANTES de deployar el backend nuevo (el registro inserta requiere_suscripcion=true).

ALTER TABLE `restaurante`
  ADD COLUMN `requiere_suscripcion` BOOLEAN NOT NULL DEFAULT false;
