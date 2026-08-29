-- T15 — Reservas atómicas de crédito marketing para envíos Growth.
--
-- Esta migración es aditiva: conserva todos los movimientos históricos y sólo
-- incorpora dos estados de ledger y la clave durable de una operación de entrega.
-- Las reservas se serializan sobre saldo_mensajes y no pueden crear deuda marketing.
--
-- PRECONDICIONES:
--   1. hacer y verificar un backup lógico consistente (MySQL confirma DDL implícitamente);
--   2. desplegar primero el backend compatible (ignora las columnas nuevas hasta T16);
--   3. confirmar que no existen valores ajenos al enum actual de tipo_transaccion.
--
-- Recuperación: detener nuevos envíos Growth. Las columnas e índice son aditivos y
-- pueden conservarse; para una reversión estricta restaurar el backup previo al DDL.

-- MySQL no permite extender un ENUM sin MODIFY. Es seguro y reintentable: conserva
-- todos los valores existentes y agrega reserva/compensacion al final.
ALTER TABLE `transaccion_mensajes`
  MODIFY COLUMN `tipo`
    ENUM('consumo','recarga','renovacion_plan','expiracion','ajuste','reserva','compensacion') NOT NULL;

SET @piru_growth_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaccion_mensajes'
      AND COLUMN_NAME = 'operacion_id'
  ),
  'SELECT 1',
  'ALTER TABLE `transaccion_mensajes` ADD COLUMN `operacion_id` VARCHAR(128) NULL AFTER `recarga_mensajes_id`'
);
PREPARE piru_growth_stmt FROM @piru_growth_sql;
EXECUTE piru_growth_stmt;
DEALLOCATE PREPARE piru_growth_stmt;

SET @piru_growth_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaccion_mensajes'
      AND COLUMN_NAME = 'reserva_origen'
  ),
  'SELECT 1',
  'ALTER TABLE `transaccion_mensajes` ADD COLUMN `reserva_origen` ENUM(''incluido'',''recarga'') NULL AFTER `operacion_id`'
);
PREPARE piru_growth_stmt FROM @piru_growth_sql;
EXECUTE piru_growth_stmt;
DEALLOCATE PREPARE piru_growth_stmt;

SET @piru_growth_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaccion_mensajes'
      AND INDEX_NAME = 'uq_transaccion_mensajes_rest_operacion'
  ),
  'SELECT 1',
  'ALTER TABLE `transaccion_mensajes` ADD UNIQUE KEY `uq_transaccion_mensajes_rest_operacion` (`restaurante_id`, `operacion_id`)'
);
PREPARE piru_growth_stmt FROM @piru_growth_sql;
EXECUTE piru_growth_stmt;
DEALLOCATE PREPARE piru_growth_stmt;

-- POSTCHECKS (sólo lectura):
--
-- 1. Deben existir las dos columnas nuevas (esperado: 2).
-- SELECT COUNT(*) AS columnas_reserva_marketing
-- FROM information_schema.COLUMNS
-- WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaccion_mensajes'
--   AND COLUMN_NAME IN ('operacion_id', 'reserva_origen');
--
-- 2. El enum debe admitir reserva y compensacion.
-- SELECT COLUMN_TYPE FROM information_schema.COLUMNS
-- WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaccion_mensajes'
--   AND COLUMN_NAME = 'tipo';
--
-- 3. Debe existir la unicidad durable por restaurante/operación.
-- SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columnas
-- FROM information_schema.STATISTICS
-- WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaccion_mensajes'
--   AND INDEX_NAME = 'uq_transaccion_mensajes_rest_operacion'
-- GROUP BY INDEX_NAME;
