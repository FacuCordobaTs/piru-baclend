-- T27 — Contenedor Google Tag Manager por restaurante.
--
-- Cambio aditivo: los storefronts y admins instalados que no conocen el campo
-- lo ignoran. El ID de GTM es público por diseño y no contiene credenciales.
--
-- PRECONDICIONES:
--   1. hacer y verificar un backup lógico consistente (MySQL confirma DDL);
--   2. desplegar primero el backend compatible con la columna opcional.
--
-- Recuperación: deshabilitar la carga GTM en el storefront. La columna puede
-- conservarse sin efectos; para revertir estrictamente, restaurar el backup.

SET @piru_growth_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurante'
      AND COLUMN_NAME = 'gtm_container_id'
  ),
  'SELECT 1',
  'ALTER TABLE `restaurante` ADD COLUMN `gtm_container_id` VARCHAR(64) NULL AFTER `username`'
);
PREPARE piru_growth_stmt FROM @piru_growth_sql;
EXECUTE piru_growth_stmt;
DEALLOCATE PREPARE piru_growth_stmt;

-- POSTCHECKS (sólo lectura):
-- SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
-- FROM information_schema.COLUMNS
-- WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurante'
--   AND COLUMN_NAME = 'gtm_container_id';
