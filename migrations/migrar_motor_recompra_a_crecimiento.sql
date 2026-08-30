DELIMITER //
DROP PROCEDURE IF EXISTS `t03_validar_motor_recompra`//
CREATE PROCEDURE `t03_validar_motor_recompra`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'modulo'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurante_modulo'
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'T03 requiere las tablas modulo y restaurante_modulo';
  END IF;

  IF (SELECT COUNT(*) FROM `modulo` WHERE `codigo` = 'motor_recompra') <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'T03 requiere exactamente un modulo motor_recompra';
  END IF;
END//
CALL `t03_validar_motor_recompra`()//
DROP PROCEDURE `t03_validar_motor_recompra`//
DELIMITER ;

START TRANSACTION;

INSERT INTO `modulo`
  (`codigo`, `categoria_id`, `nombre`, `descripcion`, `tipo_modulo`,
   `precio_mensual`, `mensajes_utility_incluidos`,
   `mensajes_marketing_incluidos`, `estado_producto`, `activable`, `icono`,
   `orden`, `activo`)
SELECT
  'crecimiento', `categoria_id`, 'Crecimiento',
  'Adquirí clientes, activá recompra y medí resultados.', `tipo_modulo`,
  `precio_mensual`, 0, 0, `estado_producto`, true, 'TrendingUp', `orden`, true
FROM `modulo`
WHERE `codigo` = 'motor_recompra'
ON DUPLICATE KEY UPDATE
  `mensajes_utility_incluidos` = 0,
  `mensajes_marketing_incluidos` = 0,
  `activable` = true,
  `activo` = true;

INSERT INTO `restaurante_modulo`
  (`restaurante_id`, `modulo_id`, `estado_restaurante_modulo`, `activado_at`,
   `desactivado_at`, `vigente_hasta`, `precio_mensual_congelado`,
   `origen_restaurante_modulo`, `cancelar_al_fin_periodo`, `created_at`,
   `updated_at`)
SELECT
  legacy.`restaurante_id`, growth.`id`,
  legacy.`estado_restaurante_modulo`, legacy.`activado_at`,
  legacy.`desactivado_at`, legacy.`vigente_hasta`,
  legacy.`precio_mensual_congelado`, legacy.`origen_restaurante_modulo`,
  legacy.`cancelar_al_fin_periodo`, legacy.`created_at`, legacy.`updated_at`
FROM `restaurante_modulo` legacy
JOIN `modulo` motor
  ON motor.`id` = legacy.`modulo_id` AND motor.`codigo` = 'motor_recompra'
JOIN `modulo` growth
  ON growth.`codigo` = 'crecimiento'
ON DUPLICATE KEY UPDATE
  `modulo_id` = VALUES(`modulo_id`);

SET `activable` = false
WHERE `codigo` = 'motor_recompra';

COMMIT;

-- POSTCHECKS (sólo lectura; todos deben devolver cero salvo el resumen):
--
-- 1. Catálogo esperado: Crecimiento activo/activable, sin cupo; Motor no activable.
-- SELECT codigo, tipo_modulo, precio_mensual, mensajes_marketing_incluidos,
--        activable, activo
-- FROM modulo WHERE codigo IN ('crecimiento', 'motor_recompra') ORDER BY codigo;
--
-- 2. Ningún entitlement del Motor quedó sin su espejo exacto.
-- SELECT COUNT(*) AS entitlements_sin_espejo
-- FROM restaurante_modulo legacy
-- JOIN modulo motor ON motor.id = legacy.modulo_id AND motor.codigo = 'motor_recompra'
-- LEFT JOIN modulo growth ON growth.codigo = 'crecimiento'
-- LEFT JOIN restaurante_modulo nuevo
--   ON nuevo.restaurante_id = legacy.restaurante_id AND nuevo.modulo_id = growth.id
-- WHERE nuevo.id IS NULL
--    OR NOT (nuevo.estado_restaurante_modulo <=> legacy.estado_restaurante_modulo)
--    OR NOT (nuevo.activado_at <=> legacy.activado_at)
--    OR NOT (nuevo.desactivado_at <=> legacy.desactivado_at)
--    OR NOT (nuevo.vigente_hasta <=> legacy.vigente_hasta)
--    OR NOT (nuevo.precio_mensual_congelado <=> legacy.precio_mensual_congelado)
--    OR NOT (nuevo.origen_restaurante_modulo <=> legacy.origen_restaurante_modulo)
--    OR NOT (nuevo.cancelar_al_fin_periodo <=> legacy.cancelar_al_fin_periodo);
--
-- 3. Resumen para conciliar cantidad de cuentas espejadas.
-- SELECT m.codigo, COUNT(rm.id) AS entitlements
-- FROM modulo m LEFT JOIN restaurante_modulo rm ON rm.modulo_id = m.id
-- WHERE m.codigo IN ('crecimiento', 'motor_recompra') GROUP BY m.codigo;
--
-- 4. La migración no crea movimientos de wallet. Comparar contra el conteo y
--    saldos registrados en el precheck/backup; este SQL no referencia esas tablas.
