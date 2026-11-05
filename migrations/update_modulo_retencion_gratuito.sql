-- Retención (`motor_recompra`) deja de ser un módulo pago: pasa a incluido,
-- sin precio, y se activa sin checkout. Agrupa el motor de recompra y el Club
-- de Puntos, y ya no se factura en la suscripción.
--
-- Los vínculos existentes conservan el acceso: los activos siguen activos y
-- los que estaban en baja programada quedan activos sin fecha de corte. Los
-- que estaban en `pendiente_pago` vuelven a `inactivo` para que se puedan
-- activar gratis (con un tipo incluido ya no tiene sentido ofrecer "Volver al
-- pago"). El precio congelado y la vigencia se limpian.
--
-- Es idempotente: se puede volver a ejecutar sin problemas.

UPDATE `modulo`
SET
  `tipo_modulo` = 'incluido',
  `precio_mensual` = 0.00,
  `activable` = true,
  `activo` = true
WHERE `codigo` = 'motor_recompra';

UPDATE `restaurante_modulo` rm
JOIN `modulo` m ON m.`id` = rm.`modulo_id`
SET
  rm.`desactivado_at` = CASE
    WHEN rm.`estado_restaurante_modulo` = 'pendiente_pago' THEN NULL
    ELSE rm.`desactivado_at`
  END,
  rm.`estado_restaurante_modulo` = CASE
    WHEN rm.`estado_restaurante_modulo` = 'cancelacion_programada' THEN 'activo'
    WHEN rm.`estado_restaurante_modulo` = 'pendiente_pago' THEN 'inactivo'
    ELSE rm.`estado_restaurante_modulo`
  END,
  rm.`precio_mensual_congelado` = NULL,
  rm.`vigente_hasta` = NULL,
  rm.`cancelar_al_fin_periodo` = false
WHERE m.`codigo` = 'motor_recompra';
