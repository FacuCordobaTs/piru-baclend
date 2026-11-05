-- Divide el módulo comercial "Retención" (`motor_recompra`) en tres capacidades
-- independientes y gratuitas:
--
--   - `motor_recompra`  → "Recompra" (la agenda de Hoy)
--   - `dias_flojos`     → "Días flojos"
--   - `puntos_clientes` → "Puntos"
--
-- Los locales que tenían Retención activa reciben automáticamente las tres
-- capacidades, sin pasar por un checkout. Los que la tenían inactiva conservan
-- exactamente lo que ya tenían: las filas nuevas no se activan solas.
--
-- El `codigo` de `motor_recompra` se conserva a propósito: es la clave de los
-- gates, de `restaurante_modulo` y de los entitlements ya vendidos. Lo que
-- desaparece es el nombre comercial "Retención". Las tres capacidades son
-- `incluido`, precio 0, sin cupos propios de mensajes.
--
-- Es idempotente: se puede volver a ejecutar sin problemas.

-- 1. Retención deja de existir como nombre comercial: pasa a ser Recompra.
UPDATE `modulo` m
JOIN `categoria_modulo` c ON c.`codigo` = 'clientes_fidelizacion'
SET
  m.`categoria_id` = c.`id`,
  m.`nombre` = 'Recompra',
  m.`descripcion` = 'La agenda de mensajes para que tus clientes vuelvan, desde el WhatsApp de tu local.',
  m.`tipo_modulo` = 'incluido',
  m.`precio_mensual` = 0.00,
  m.`estado_producto` = 'disponible',
  m.`activable` = true,
  m.`icono` = 'Repeat2',
  m.`orden` = 4,
  m.`activo` = true
WHERE m.`codigo` = 'motor_recompra';

INSERT INTO `modulo`
  (`codigo`, `categoria_id`, `nombre`, `descripcion`, `tipo_modulo`,
   `precio_mensual`, `mensajes_utility_incluidos`, `mensajes_marketing_incluidos`,
   `estado_producto`, `activable`, `icono`, `orden`, `activo`)
SELECT
  'puntos_clientes', c.`id`, 'Puntos',
  'El club de puntos del local: cada compra suma y se puede canjear.',
  'incluido', 0.00, 0, 0, 'disponible', true, 'Sparkles', 5, true
FROM `categoria_modulo` c
WHERE c.`codigo` = 'clientes_fidelizacion'
ON DUPLICATE KEY UPDATE
  `categoria_id` = VALUES(`categoria_id`),
  `nombre` = VALUES(`nombre`),
  `descripcion` = VALUES(`descripcion`),
  `tipo_modulo` = VALUES(`tipo_modulo`),
  `precio_mensual` = VALUES(`precio_mensual`),
  `mensajes_utility_incluidos` = 0,
  `mensajes_marketing_incluidos` = 0,
  `estado_producto` = VALUES(`estado_producto`),
  `activable` = VALUES(`activable`),
  `icono` = VALUES(`icono`),
  `orden` = VALUES(`orden`),
  `activo` = true;

INSERT INTO `modulo`
  (`codigo`, `categoria_id`, `nombre`, `descripcion`, `tipo_modulo`,
   `precio_mensual`, `mensajes_utility_incluidos`, `mensajes_marketing_incluidos`,
   `estado_producto`, `activable`, `icono`, `orden`, `activo`)
SELECT
  'dias_flojos', c.`id`, 'Días flojos',
  'Mirá cuándo se vende menos y llevá a tus clientes justo esos días.',
  'incluido', 0.00, 0, 0, 'disponible', true, 'CalendarDays', 6, true
FROM `categoria_modulo` c
WHERE c.`codigo` = 'clientes_fidelizacion'
ON DUPLICATE KEY UPDATE
  `categoria_id` = VALUES(`categoria_id`),
  `nombre` = VALUES(`nombre`),
  `descripcion` = VALUES(`descripcion`),
  `tipo_modulo` = VALUES(`tipo_modulo`),
  `precio_mensual` = VALUES(`precio_mensual`),
  `mensajes_utility_incluidos` = 0,
  `mensajes_marketing_incluidos` = 0,
  `estado_producto` = VALUES(`estado_producto`),
  `activable` = VALUES(`activable`),
  `icono` = VALUES(`icono`),
  `orden` = VALUES(`orden`),
  `activo` = true;

UPDATE `restaurante_modulo` rm
JOIN `modulo` m ON m.`id` = rm.`modulo_id`
SET
  rm.`precio_mensual_congelado` = NULL,
  rm.`vigente_hasta` = NULL,
  rm.`cancelar_al_fin_periodo` = false
WHERE m.`codigo` = 'motor_recompra';

INSERT INTO `restaurante_modulo`
  (`restaurante_id`, `modulo_id`, `estado_restaurante_modulo`, `activado_at`,
   `desactivado_at`, `vigente_hasta`, `precio_mensual_congelado`,
   `origen_restaurante_modulo`, `cancelar_al_fin_periodo`, `created_at`, `updated_at`)
SELECT
  rm.`restaurante_id`, nuevo.`id`, 'activo',
  COALESCE(rm.`activado_at`, CURRENT_TIMESTAMP),
  NULL, NULL, NULL, 'migracion', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM `restaurante_modulo` rm
JOIN `modulo` ret ON ret.`id` = rm.`modulo_id` AND ret.`codigo` = 'motor_recompra'
JOIN `modulo` nuevo ON nuevo.`codigo` IN ('puntos_clientes', 'dias_flojos')
WHERE rm.`estado_restaurante_modulo` IN ('activo', 'cancelacion_programada')
ON DUPLICATE KEY UPDATE
  `estado_restaurante_modulo` = 'activo',
  `activado_at` = COALESCE(`restaurante_modulo`.`activado_at`, VALUES(`activado_at`)),
  `desactivado_at` = NULL,
  `vigente_hasta` = NULL,
  `precio_mensual_congelado` = NULL,
  `cancelar_al_fin_periodo` = false,
  `updated_at` = CURRENT_TIMESTAMP;

SELECT codigo, nombre, tipo_modulo, precio_mensual, activable, activo
FROM modulo WHERE codigo IN ('motor_recompra', 'dias_flojos', 'puntos_clientes')
ORDER BY orden;

SELECT COUNT(*) AS faltantes
FROM restaurante_modulo ret
JOIN modulo m ON m.id = ret.modulo_id AND m.codigo = 'motor_recompra'
JOIN modulo nuevo ON nuevo.codigo IN ('puntos_clientes', 'dias_flojos')
LEFT JOIN restaurante_modulo rm
ON rm.restaurante_id = ret.restaurante_id AND rm.modulo_id = nuevo.id
WHERE ret.estado_restaurante_modulo = 'activo'
AND (rm.id IS NULL OR rm.estado_restaurante_modulo <> 'activo');
