-- Pixel de Meta por restaurante.
--
-- Cambio aditivo: los storefronts y admins instalados que no conocen el campo lo
-- ignoran. El ID del pixel es público por diseño y no contiene credenciales, así
-- que vive en la tabla y no en variables de entorno.
--
-- PRECONDICIONES:
--   1. hacer y verificar un backup lógico consistente (MySQL confirma DDL);
--   2. desplegar primero el backend compatible con la columna opcional.
--
-- Recuperación: desconfigurar el pixel en Ajustes -> General. La columna puede
-- conservarse sin efectos; para revertir estrictamente, restaurar el backup.

SET @piru_meta_pixel_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurante'
      AND COLUMN_NAME = 'meta_pixel_id'
  ),
  'SELECT 1',
  'ALTER TABLE `restaurante` ADD COLUMN `meta_pixel_id` VARCHAR(32) NULL AFTER `gtm_container_id`'
);
PREPARE piru_meta_pixel_stmt FROM @piru_meta_pixel_sql;
EXECUTE piru_meta_pixel_stmt;
DEALLOCATE PREPARE piru_meta_pixel_stmt;

-- POSTCHECKS (sólo lectura):
-- SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
-- FROM information_schema.COLUMNS
-- WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurante'
--   AND COLUMN_NAME = 'meta_pixel_id';
