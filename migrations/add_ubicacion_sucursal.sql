-- Ubicación geocodificada por sucursal.
-- Cambio aditivo: las sucursales existentes conservan su dirección de texto y
-- pueden completar coordenadas/ciudad desde Ajustes sin afectar pedidos viejos.
--
-- No usa `ADD COLUMN IF NOT EXISTS`: algunas versiones de MySQL no aceptan esa
-- sintaxis. Los chequeos contra information_schema mantienen la migración
-- idempotente sin requerir permisos para crear procedimientos almacenados.

ALTER TABLE `sucursal`
  MODIFY COLUMN `direccion` VARCHAR(512) NULL DEFAULT NULL;

SET @piru_schema = DATABASE();

SET @piru_sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @piru_schema
      AND TABLE_NAME = 'sucursal'
      AND COLUMN_NAME = 'direccion_lat'
  ),
  'SELECT 1',
  'ALTER TABLE `sucursal` ADD COLUMN `direccion_lat` DECIMAL(10, 7) NULL DEFAULT NULL AFTER `direccion`'
);
PREPARE piru_stmt FROM @piru_sql;
EXECUTE piru_stmt;
DEALLOCATE PREPARE piru_stmt;

SET @piru_sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @piru_schema
      AND TABLE_NAME = 'sucursal'
      AND COLUMN_NAME = 'direccion_lng'
  ),
  'SELECT 1',
  'ALTER TABLE `sucursal` ADD COLUMN `direccion_lng` DECIMAL(10, 7) NULL DEFAULT NULL AFTER `direccion_lat`'
);
PREPARE piru_stmt FROM @piru_sql;
EXECUTE piru_stmt;
DEALLOCATE PREPARE piru_stmt;

SET @piru_sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @piru_schema
      AND TABLE_NAME = 'sucursal'
      AND COLUMN_NAME = 'direccion_ciudad'
  ),
  'SELECT 1',
  'ALTER TABLE `sucursal` ADD COLUMN `direccion_ciudad` VARCHAR(255) NULL DEFAULT NULL AFTER `direccion_lng`'
);
PREPARE piru_stmt FROM @piru_sql;
EXECUTE piru_stmt;
DEALLOCATE PREPARE piru_stmt;

SET @piru_schema = NULL;
SET @piru_sql = NULL;
