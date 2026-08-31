-- La atribución comercial de una compra no puede depender de que exista una
-- sesión analítica del navegador. El pedido trae el slug de campaña y el
-- backend lo valida por restaurante; marketing_sesion_id queda como contexto
-- opcional para navegadores que sí permiten tracking.
--
-- Migración aditiva/retrocompatible: sólo relaja NOT NULL. La FK, el índice y
-- todas las filas existentes se conservan. Ejecutar después de un backup.

DELIMITER $$
CREATE PROCEDURE fix_growth_campaign_attribution_nullable_session()
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'pedido_marketing_atribucion'
      AND COLUMN_NAME = 'marketing_sesion_id'
      AND IS_NULLABLE = 'NO'
  ) THEN
    ALTER TABLE pedido_marketing_atribucion
      MODIFY COLUMN marketing_sesion_id INT NULL;
  END IF;
END$$
DELIMITER ;

CALL fix_growth_campaign_attribution_nullable_session();
DROP PROCEDURE fix_growth_campaign_attribution_nullable_session;

-- POSTCHECK (resultado esperado: YES).
SELECT IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'pedido_marketing_atribucion'
  AND COLUMN_NAME = 'marketing_sesion_id';
