-- Alfajor deja de usar la excepción grandfathered: requiere la suscripción
-- base y el módulo Avisos se cobra como cualquier módulo pago (+$30.000).
--
-- PRECONDICIÓN: realizar y verificar un backup lógico antes de ejecutar.
-- Esta migración sólo cambia el restaurante identificado explícitamente y su
-- entitlement de Avisos; no toca Cucuru, pedidos, recargas ni pagos históricos.
-- Es idempotente y puede ejecutarse después de add_suscripcion_unica_modulos.sql.

START TRANSACTION;

UPDATE `restaurante`
SET `requiere_suscripcion` = true
WHERE LOWER(COALESCE(`username`, '')) IN ('alfajor', 'alfajorconpapas')
   OR LOWER(COALESCE(`nombre`, '')) = 'alfajor con papas';

INSERT INTO `restaurante_modulo`
  (`restaurante_id`, `modulo_id`, `estado_restaurante_modulo`, `activado_at`, `desactivado_at`, `vigente_hasta`, `precio_mensual_congelado`, `origen_restaurante_modulo`, `cancelar_al_fin_periodo`)
SELECT r.id, m.id, 'activo', CURRENT_TIMESTAMP, NULL, NULL, m.precio_mensual, 'migracion', false
FROM `restaurante` r
JOIN `modulo` m ON m.codigo = 'avisos_automaticos_whatsapp' AND m.activo = true
WHERE LOWER(COALESCE(r.username, '')) IN ('alfajor', 'alfajorconpapas')
   OR LOWER(COALESCE(r.nombre, '')) = 'alfajor con papas'
ON DUPLICATE KEY UPDATE
  `estado_restaurante_modulo` = 'activo',
  `activado_at` = COALESCE(`activado_at`, CURRENT_TIMESTAMP),
  `desactivado_at` = NULL,
  `vigente_hasta` = NULL,
  `precio_mensual_congelado` = VALUES(`precio_mensual_congelado`),
  `origen_restaurante_modulo` = 'migracion',
  `cancelar_al_fin_periodo` = false;

COMMIT;

-- Verificación posterior (no modifica datos):
-- SELECT r.id, r.nombre, r.requiere_suscripcion, rm.estado_restaurante_modulo,
--        rm.precio_mensual_congelado, rm.origen_restaurante_modulo
-- FROM restaurante r
-- JOIN restaurante_modulo rm ON rm.restaurante_id = r.id
-- JOIN modulo m ON m.id = rm.modulo_id AND m.codigo = 'avisos_automaticos_whatsapp'
-- WHERE LOWER(COALESCE(r.username, '')) IN ('alfajor', 'alfajorconpapas')
--    OR LOWER(COALESCE(r.nombre, '')) = 'alfajor con papas';
