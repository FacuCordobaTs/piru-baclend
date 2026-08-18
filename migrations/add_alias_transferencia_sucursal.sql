-- Alias de transferencia opcional por sucursal.
-- Si queda NULL, el checkout conserva el alias general del restaurante.
-- Compatible con MySQL sin soporte para `ADD COLUMN IF NOT EXISTS`.

SET @piru_schema = DATABASE();
SET @piru_sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @piru_schema
      AND TABLE_NAME = 'sucursal'
      AND COLUMN_NAME = 'transferencia_alias'
  ),
  'SELECT 1',
  'ALTER TABLE `sucursal` ADD COLUMN `transferencia_alias` VARCHAR(255) NULL DEFAULT NULL AFTER `direccion_ciudad`'
);
PREPARE piru_stmt FROM @piru_sql;
EXECUTE piru_stmt;
DEALLOCATE PREPARE piru_stmt;

SET @piru_schema = NULL;
SET @piru_sql = NULL;
