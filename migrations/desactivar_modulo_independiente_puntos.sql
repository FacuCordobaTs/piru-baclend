-- El programa de Club de Puntos ahora forma parte exclusiva del módulo
-- pago "Herramientas de retención" (motor_recompra, +$20.000/mes).
-- Se retira puntos_clientes del catálogo independiente y se desactivan
-- entitlements legacy huérfanos que no cuenten con motor_recompra activo.
--
-- Es idempotente: se puede volver a ejecutar sin problemas.

UPDATE `modulo`
SET
  `activable` = false,
  `activo` = false
WHERE `codigo` = 'puntos_clientes';

-- Desactivar en restaurante_modulo los registros de puntos_clientes para locales que no tengan motor_recompra activo
UPDATE `restaurante_modulo` rm
JOIN `modulo` m ON m.id = rm.modulo_id AND m.codigo = 'puntos_clientes'
LEFT JOIN (
  SELECT rm2.restaurante_id
  FROM `restaurante_modulo` rm2
  JOIN `modulo` m2 ON m2.id = rm2.modulo_id AND m2.codigo = 'motor_recompra'
  WHERE rm2.estado_restaurante_modulo = 'activo'
) ret ON ret.restaurante_id = rm.restaurante_id
SET rm.estado_restaurante_modulo = 'inactivo',
    rm.desactivado_at = CURRENT_TIMESTAMP
WHERE ret.restaurante_id IS NULL;