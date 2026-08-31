-- Campañas Growth minimalistas: una oferta asociada a un único producto.
--
-- Migración aditiva y retrocompatible. Los campos anteriores de campaña se
-- conservan para los bundles instalados y para poder reincorporar capacidades.
-- Ejecutar después de un backup lógico verificado. No usar drizzle push.

DELIMITER $$
CREATE PROCEDURE add_growth_campaign_product_promo_columns()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_campana'
      AND COLUMN_NAME = 'descuento_producto_porcentaje'
  ) THEN
    ALTER TABLE marketing_campana
      ADD COLUMN descuento_producto_porcentaje INT NOT NULL DEFAULT 0 AFTER codigo_descuento_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_campana'
      AND COLUMN_NAME = 'limite_usos'
  ) THEN
    ALTER TABLE marketing_campana
      ADD COLUMN limite_usos INT NULL AFTER descuento_producto_porcentaje;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_campana'
      AND COLUMN_NAME = 'usos_actuales'
  ) THEN
    ALTER TABLE marketing_campana
      ADD COLUMN usos_actuales INT NOT NULL DEFAULT 0 AFTER limite_usos;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_campana'
      AND COLUMN_NAME = 'fecha_inicio'
  ) THEN
    ALTER TABLE marketing_campana
      ADD COLUMN fecha_inicio TIMESTAMP NULL AFTER usos_actuales;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_campana'
      AND COLUMN_NAME = 'fecha_fin'
  ) THEN
    ALTER TABLE marketing_campana
      ADD COLUMN fecha_fin TIMESTAMP NULL AFTER fecha_inicio;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_campana'
      AND COLUMN_NAME = 'visitas'
  ) THEN
    ALTER TABLE marketing_campana
      ADD COLUMN visitas INT NOT NULL DEFAULT 0 AFTER fecha_fin;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_campana'
      AND CONSTRAINT_NAME = 'chk_marketing_campana_descuento_producto'
  ) THEN
    ALTER TABLE marketing_campana ADD CONSTRAINT chk_marketing_campana_descuento_producto
      CHECK (descuento_producto_porcentaje BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_campana'
      AND CONSTRAINT_NAME = 'chk_marketing_campana_limite_usos'
  ) THEN
    ALTER TABLE marketing_campana ADD CONSTRAINT chk_marketing_campana_limite_usos
      CHECK (limite_usos IS NULL OR limite_usos > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_campana'
      AND CONSTRAINT_NAME = 'chk_marketing_campana_usos_actuales'
  ) THEN
    ALTER TABLE marketing_campana ADD CONSTRAINT chk_marketing_campana_usos_actuales
      CHECK (usos_actuales >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_campana'
      AND CONSTRAINT_NAME = 'chk_marketing_campana_visitas'
  ) THEN
    ALTER TABLE marketing_campana ADD CONSTRAINT chk_marketing_campana_visitas
      CHECK (visitas >= 0);
  END IF;
END$$
DELIMITER ;

CALL add_growth_campaign_product_promo_columns();
DROP PROCEDURE add_growth_campaign_product_promo_columns;

-- PRECHECK/POSTCHECK de datos (resultado esperado: 0 filas inválidas).
SELECT id, restaurante_id, descuento_producto_porcentaje, limite_usos, usos_actuales
FROM marketing_campana
WHERE descuento_producto_porcentaje < 0
   OR descuento_producto_porcentaje > 100
   OR (limite_usos IS NOT NULL AND limite_usos <= 0)
   OR usos_actuales < 0
   OR visitas < 0;

-- Verificación estructural (resultado esperado: 6).
SELECT COUNT(*) AS columnas_oferta_producto
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'marketing_campana'
  AND COLUMN_NAME IN (
    'descuento_producto_porcentaje', 'limite_usos', 'usos_actuales',
    'fecha_inicio', 'fecha_fin', 'visitas'
  );
