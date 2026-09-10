-- Marca el módulo puntos_clientes como disponible y activable para todos los restaurantes.
-- Idempotente: seguro para reejecutar.

UPDATE `modulo`
SET
  `estado_producto` = 'disponible',
  `activable` = true
WHERE `codigo` = 'puntos_clientes';
