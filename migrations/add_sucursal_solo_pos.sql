-- Aditiva. Aplicar ANTES del backend. No crea sucursales ni modifica pedidos,
-- zonas, pagos, módulos o configuraciones de ningún restaurante.
SET @piru_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sucursal' AND COLUMN_NAME = 'solo_pos'),
  'SELECT 1',
  'ALTER TABLE sucursal ADD COLUMN solo_pos TINYINT(1) NOT NULL DEFAULT 0 AFTER nombre'
);
PREPARE piru_stmt FROM @piru_sql;
EXECUTE piru_stmt;
DEALLOCATE PREPARE piru_stmt;
SET @piru_sql = NULL;
