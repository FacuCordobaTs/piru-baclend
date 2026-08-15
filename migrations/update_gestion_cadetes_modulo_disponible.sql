-- Gestión de Cadetes ya cuenta con alta/baja de repartidores, estadísticas,
-- asignación en el despacho y controles backend sobre pedido_unificado. El seed
-- original la dejó por error como "proximamente", impidiendo activarla desde el
-- catálogo y ocultando esas superficies aunque el producto estaba construido.
--
-- Es idempotente y no activa el módulo para ningún restaurante: sólo corrige el
-- estado global del producto para que cada local pueda elegir activarlo.

UPDATE `modulo`
SET
  `estado_producto` = 'disponible',
  `activable` = true
WHERE `codigo` = 'gestion_cadetes';
