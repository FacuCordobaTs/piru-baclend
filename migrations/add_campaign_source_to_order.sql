-- Fuente operativa de campaña en el pedido.
--
-- La atribución ya no depende de insertar después una fila analítica: el ID se
-- escribe en el mismo INSERT que crea pedido_unificado. La tabla
-- pedido_marketing_atribucion continúa como ledger detallado y se usa para
-- backfillear las atribuciones que ya estaban correctamente registradas.
-- Migración aditiva e idempotente. Ejecutar después de un backup.

DELIMITER $$
CREATE PROCEDURE add_campaign_source_to_order()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'pedido_unificado'
      AND COLUMN_NAME = 'marketing_campana_id'
  ) THEN
    ALTER TABLE pedido_unificado
      ADD COLUMN marketing_campana_id INT NULL AFTER cliente_id;
  END IF;

  UPDATE pedido_unificado p
  INNER JOIN pedido_marketing_atribucion a
    ON a.restaurante_id = p.restaurante_id
   AND a.pedido_unificado_id = p.id
  SET p.marketing_campana_id = a.campana_id
  WHERE p.marketing_campana_id IS NULL
    AND a.campana_id IS NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'pedido_unificado'
      AND INDEX_NAME = 'idx_pedido_unificado_marketing_campana'
  ) THEN
    CREATE INDEX idx_pedido_unificado_marketing_campana
      ON pedido_unificado (restaurante_id, marketing_campana_id, created_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'pedido_unificado'
      AND CONSTRAINT_NAME = 'fk_pedido_unificado_marketing_campana'
  ) THEN
    ALTER TABLE pedido_unificado
      ADD CONSTRAINT fk_pedido_unificado_marketing_campana
      FOREIGN KEY (marketing_campana_id) REFERENCES marketing_campana(id)
      ON DELETE SET NULL;
  END IF;
END$$
DELIMITER ;

CALL add_campaign_source_to_order();
DROP PROCEDURE add_campaign_source_to_order;

-- POSTCHECK: debe devolver la columna nullable, el índice y la FK.
SELECT COLUMN_NAME, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'pedido_unificado'
  AND COLUMN_NAME = 'marketing_campana_id';

SELECT CONSTRAINT_NAME
FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
  AND TABLE_NAME = 'pedido_unificado'
  AND CONSTRAINT_NAME = 'fk_pedido_unificado_marketing_campana';
