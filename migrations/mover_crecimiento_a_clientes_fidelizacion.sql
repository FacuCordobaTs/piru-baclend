-- Campañas de adquisición (`crecimiento`) es una herramienta incluida de
-- clientes: tiene que mostrarse junto a Códigos de descuento, dentro de
-- "Clientes y fidelización", y no bajo "Módulos pagos".
--
-- La categoría venía heredada de `motor_recompra` (`modulos_pagos`) y el tipo
-- podía seguir en `pago` si no se había ejecutado
-- `update_modulo_crecimiento_gratuito.sql`. Se normalizan ambos y se limpia el
-- snapshot de cobro de los vínculos existentes.
--
-- Es idempotente: se puede volver a ejecutar sin problemas.

UPDATE `modulo` m
JOIN `categoria_modulo` c ON c.`codigo` = 'clientes_fidelizacion'
SET
  m.`categoria_id` = c.`id`,
  m.`tipo_modulo` = 'incluido',
  m.`precio_mensual` = 0.00,
  m.`activable` = true,
  m.`activo` = true,
  m.`orden` = 3
WHERE m.`codigo` = 'crecimiento';

UPDATE `restaurante_modulo` rm
JOIN `modulo` m ON m.`id` = rm.`modulo_id`
SET
  rm.`precio_mensual_congelado` = NULL,
  rm.`vigente_hasta` = NULL,
  rm.`cancelar_al_fin_periodo` = false
WHERE m.`codigo` = 'crecimiento';
