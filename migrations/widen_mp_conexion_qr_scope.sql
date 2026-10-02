-- OAuth de Mercado Pago devuelve scopes con URNs que superan VARCHAR(255).
-- El callback ya recibió los tokens, pero el INSERT/UPDATE falla con ER_DATA_TOO_LONG.
-- Ampliar la columna conserva íntegros los permisos y permite conectar y renovar tokens.
--
-- Aplicar ANTES del backend actualizado. Compatible con el backend anterior y reintentable.
-- Requiere add_mp_conexion_qr.sql; no volver a ejecutar el CREATE TABLE histórico para ampliar.
-- MySQL confirma DDL de forma implícita: realizar backup lógico verificado antes de aplicar.
-- No reducir nuevamente a VARCHAR(255): truncaría scopes ya guardados.

ALTER TABLE `mp_conexion_qr`
  MODIFY COLUMN `scope` TEXT NULL DEFAULT NULL;

SELECT `DATA_TYPE`, `CHARACTER_MAXIMUM_LENGTH`, `IS_NULLABLE`
FROM `information_schema`.`COLUMNS`
WHERE `TABLE_SCHEMA` = DATABASE()
  AND `TABLE_NAME` = 'mp_conexion_qr'
  AND `COLUMN_NAME` = 'scope';
