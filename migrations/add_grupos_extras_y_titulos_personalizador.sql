-- Personalizador de producto: dos grupos de extras y títulos configurables.
-- Aditiva, con defaults que preservan el contrato de clientes anteriores.
-- Las guardas permiten reintentar la migración en MySQL sin ADD COLUMN IF NOT EXISTS.

DROP PROCEDURE IF EXISTS `add_grupos_extras_y_titulos_personalizador`;
DELIMITER $$
CREATE PROCEDURE `add_grupos_extras_y_titulos_personalizador`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'producto_agregado' AND COLUMN_NAME = 'grupo'
  ) THEN
    ALTER TABLE `producto_agregado`
      ADD COLUMN `grupo` INT NOT NULL DEFAULT 1 AFTER `agregado_id`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'producto' AND COLUMN_NAME = 'titulo_variantes_primarias'
  ) THEN
    ALTER TABLE `producto`
      ADD COLUMN `titulo_variantes_primarias` VARCHAR(120) NOT NULL DEFAULT 'Elegí una opción' AFTER `tiene_variantes`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'producto' AND COLUMN_NAME = 'titulo_variantes_secundarias'
  ) THEN
    ALTER TABLE `producto`
      ADD COLUMN `titulo_variantes_secundarias` VARCHAR(120) NOT NULL DEFAULT 'Elegí también una segunda opción' AFTER `titulo_variantes_primarias`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'producto' AND COLUMN_NAME = 'titulo_extras_primarios'
  ) THEN
    ALTER TABLE `producto`
      ADD COLUMN `titulo_extras_primarios` VARCHAR(120) NOT NULL DEFAULT 'Extras' AFTER `titulo_variantes_secundarias`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'producto' AND COLUMN_NAME = 'titulo_extras_secundarios'
  ) THEN
    ALTER TABLE `producto`
      ADD COLUMN `titulo_extras_secundarios` VARCHAR(120) NOT NULL DEFAULT 'Extras' AFTER `titulo_extras_primarios`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'producto_agregado' AND INDEX_NAME = 'idx_producto_agregado_grupo'
  ) THEN
    CREATE INDEX `idx_producto_agregado_grupo` ON `producto_agregado` (`producto_id`, `grupo`);
  END IF;
END$$
DELIMITER ;

CALL `add_grupos_extras_y_titulos_personalizador`();
DROP PROCEDURE IF EXISTS `add_grupos_extras_y_titulos_personalizador`;
