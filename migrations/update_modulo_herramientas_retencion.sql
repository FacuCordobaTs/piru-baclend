-- Actualiza el módulo motor_recompra para pasar a llamarse "Herramientas de retención"
-- y ajusta su precio mensual de $70.000 a $20.000, asegurando que quede activo y activable.
--
-- Es idempotente: se puede volver a ejecutar sin problemas.

UPDATE `modulo`
SET
  `nombre` = 'Herramientas de retención',
  `descripcion` = 'Segmentación inteligente de clientes, micro-campañas de recompra y Club de Puntos.',
  `precio_mensual` = 20000.00,
  `activable` = true,
  `activo` = true
WHERE `codigo` = 'motor_recompra';
