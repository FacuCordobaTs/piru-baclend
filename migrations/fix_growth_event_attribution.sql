-- Hace que los eventos semánticos de campaña (carrito/checkout) no dependan
-- de que marketing_sesion pueda escribirse. La sesión sigue utilizándose
-- normalmente; campana_id + sesion_uuid son el fallback durable y auditable.
-- Migración aditiva/retrocompatible. Ejecutar después de un backup.

DELIMITER $$
CREATE PROCEDURE fix_growth_event_attribution()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_evento'
      AND COLUMN_NAME = 'marketing_sesion_id' AND IS_NULLABLE = 'NO'
  ) THEN
    ALTER TABLE marketing_evento MODIFY COLUMN marketing_sesion_id INT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_evento'
      AND COLUMN_NAME = 'sesion_uuid'
  ) THEN
    ALTER TABLE marketing_evento ADD COLUMN sesion_uuid VARCHAR(64) NULL AFTER marketing_sesion_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_evento'
      AND COLUMN_NAME = 'campana_id'
  ) THEN
    ALTER TABLE marketing_evento ADD COLUMN campana_id INT NULL AFTER sesion_uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_evento'
      AND INDEX_NAME = 'idx_marketing_evento_campana_fecha'
  ) THEN
    CREATE INDEX idx_marketing_evento_campana_fecha
      ON marketing_evento (restaurante_id, campana_id, ocurrido_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_evento'
      AND INDEX_NAME = 'idx_marketing_evento_sesion_uuid'
  ) THEN
    CREATE INDEX idx_marketing_evento_sesion_uuid
      ON marketing_evento (restaurante_id, sesion_uuid);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_evento'
      AND CONSTRAINT_NAME = 'fk_marketing_evento_campana'
  ) THEN
    ALTER TABLE marketing_evento
      ADD CONSTRAINT fk_marketing_evento_campana
      FOREIGN KEY (campana_id) REFERENCES marketing_campana(id);
  END IF;
END$$
DELIMITER ;

CALL fix_growth_event_attribution();
DROP PROCEDURE fix_growth_event_attribution;

-- POSTCHECK (esperado: marketing_sesion_id=YES y dos columnas nuevas).
SELECT COLUMN_NAME, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_evento'
  AND COLUMN_NAME IN ('marketing_sesion_id', 'sesion_uuid', 'campana_id')
ORDER BY COLUMN_NAME;
