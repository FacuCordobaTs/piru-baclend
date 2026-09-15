-- Separación definitiva de Crecimiento y Motor de Recompra.
-- La migración T03 copió entitlements del Motor a Crecimiento para sostener el
-- alias transitorio. Sólo se desactivan copias que todavía son idénticas en
-- todos los snapshots operativos; una compra/edición posterior deja de cumplir
-- esta igualdad y se preserva como entitlement independiente.

UPDATE `restaurante_modulo` growth_rm
JOIN `modulo` growth
  ON growth.id = growth_rm.modulo_id AND growth.codigo = 'crecimiento'
JOIN `restaurante_modulo` motor_rm
  ON motor_rm.restaurante_id = growth_rm.restaurante_id
JOIN `modulo` motor
  ON motor.id = motor_rm.modulo_id AND motor.codigo = 'motor_recompra'
SET
  growth_rm.estado_restaurante_modulo = 'inactivo',
  growth_rm.desactivado_at = COALESCE(growth_rm.desactivado_at, CURRENT_TIMESTAMP),
  growth_rm.vigente_hasta = NULL,
  growth_rm.precio_mensual_congelado = NULL,
  growth_rm.cancelar_al_fin_periodo = FALSE,
  growth_rm.updated_at = CURRENT_TIMESTAMP
WHERE growth_rm.estado_restaurante_modulo = motor_rm.estado_restaurante_modulo
  AND growth_rm.activado_at <=> motor_rm.activado_at
  AND growth_rm.desactivado_at <=> motor_rm.desactivado_at
  AND growth_rm.vigente_hasta <=> motor_rm.vigente_hasta
  AND growth_rm.precio_mensual_congelado <=> motor_rm.precio_mensual_congelado
  AND growth_rm.origen_restaurante_modulo <=> motor_rm.origen_restaurante_modulo
  AND growth_rm.cancelar_al_fin_periodo = motor_rm.cancelar_al_fin_periodo
  AND growth_rm.created_at <=> motor_rm.created_at;

-- POSTCHECK: no deben quedar pares espejo activos.
-- SELECT COUNT(*) FROM restaurante_modulo growth_rm
-- JOIN modulo growth ON growth.id = growth_rm.modulo_id AND growth.codigo = 'crecimiento'
-- JOIN restaurante_modulo motor_rm ON motor_rm.restaurante_id = growth_rm.restaurante_id
-- JOIN modulo motor ON motor.id = motor_rm.modulo_id AND motor.codigo = 'motor_recompra'
-- WHERE growth_rm.estado_restaurante_modulo = 'activo'
--   AND growth_rm.activado_at <=> motor_rm.activado_at
--   AND growth_rm.created_at <=> motor_rm.created_at;
