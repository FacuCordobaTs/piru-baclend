-- Cupones: distinguir los que el sistema emite solo de los que el dueño crea
-- a propósito en Clientes/Cupones.
--
-- Tres caminos insertan un cupón de un solo uso por destinatario, sin pasar por
-- la pantalla de Cupones:
--   * Smart Links de Growth            -> `GROWTH-<cliente>-<rand>`  (routes/marketing.ts)
--   * Enlaces de micro-campaña/retención -> `CRECE-<cliente>-<hash>`  (routes/marketing.ts)
--   * Escalera del Motor de Recompra   -> `VOLVE<descuento>-<cliente>` (lib/recupero.ts)
-- Ese goteo llena la lista de cupones con ruido que nadie administra. Con esta
-- marca, `GET /codigo-descuento` devuelve por defecto sólo los intencionales.
--
-- Aditiva y retrocompatible: los clientes viejos ignoran la columna y el default
-- `false` deja el comportamiento previo intacto hasta que corra el backfill.
-- El backfill sólo toca los códigos con prefijo del sistema; nunca un cupón
-- elegido a mano para asociarlo a una campaña (eso sigue siendo intencional).
--
-- Idempotente: se puede correr dos veces sin efecto. No usar drizzle push.

DELIMITER $$
CREATE PROCEDURE add_codigo_descuento_generado_automaticamente()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'codigo_descuento'
      AND COLUMN_NAME = 'generado_automaticamente'
  ) THEN
    ALTER TABLE codigo_descuento
      ADD COLUMN generado_automaticamente BOOLEAN NOT NULL DEFAULT false AFTER activo;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'codigo_descuento'
      AND INDEX_NAME = 'idx_codigo_descuento_rest_auto'
  ) THEN
    ALTER TABLE codigo_descuento
      ADD INDEX idx_codigo_descuento_rest_auto (restaurante_id, generado_automaticamente);
  END IF;
END $$
DELIMITER ;

CALL add_codigo_descuento_generado_automaticamente();
DROP PROCEDURE IF EXISTS add_codigo_descuento_generado_automaticamente;

-- Backfill de los cupones que el sistema ya emitió antes de esta migración.
-- `^VOLVE[0-9]+-` exige dígitos para no pisar un cupón manual tipo "VOLVER10".
UPDATE codigo_descuento
SET generado_automaticamente = true
WHERE generado_automaticamente = false
  AND (
    codigo LIKE 'GROWTH-%'
    OR codigo LIKE 'CRECE-%'
    OR codigo REGEXP '^VOLVE[0-9]+-'
  );
