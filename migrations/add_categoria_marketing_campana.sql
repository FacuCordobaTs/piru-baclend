-- Categorías canónicas de campañas Growth para organización del administrador.
--
-- Migración aditiva y retrocompatible. No altera el comportamiento de compra
-- ni la experiencia del cliente. Ejecutar tras backup lógico.

DELIMITER $$
CREATE PROCEDURE add_categoria_marketing_campana_column()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_campana'
      AND COLUMN_NAME = 'categoria'
  ) THEN
    ALTER TABLE marketing_campana
      ADD COLUMN categoria VARCHAR(64) NULL AFTER tipo;
  END IF;
END $$
DELIMITER ;

CALL add_categoria_marketing_campana_column();
DROP PROCEDURE IF EXISTS add_categoria_marketing_campana_column;
