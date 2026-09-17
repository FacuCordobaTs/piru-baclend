-- Unificación comercial: el Club de Puntos y el Motor de Recompra pasan a ser
-- un único módulo llamado "Retención", con precio mensual de $30.000.
--
-- El `codigo` sigue siendo `motor_recompra` a propósito: es la clave de los
-- gates (`MODULE_KEYS`), de `planes.ts`, de `restaurante_modulo` y de los
-- entitlements ya vendidos. Renombrarlo obligaría a migrar filas y a tocar
-- todos los puntos de control sin cambiar nada del producto. Lo que cambia es
-- el nombre visible y el precio de lista.
--
-- Es idempotente: se puede volver a ejecutar sin problemas.
--
-- No se toca `restaurante_modulo.precio_mensual_congelado`: los locales que ya
-- tienen el módulo activo conservan el precio que venían pagando. El precio
-- nuevo aplica a las activaciones nuevas.

UPDATE `modulo`
SET
  `nombre` = 'Retención',
  `descripcion` = 'Fidelización y recompra: Club de Puntos, segmentación de clientes y motor automático de recupero.',
  `precio_mensual` = 30000.00,
  `activable` = true,
  `activo` = true
WHERE `codigo` = 'motor_recompra';

UPDATE `modulo`
SET
  `nombre` = 'Puntos para clientes',
  `descripcion` = 'Incluido en Retención: Club de Puntos con saldo, canjes y ajustes.',
  `activable` = false,
  `activo` = false
WHERE `codigo` = 'puntos_clientes';
