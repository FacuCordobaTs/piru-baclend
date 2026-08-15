-- Mesas ya cuenta con CRUD, editor, grid operativo y comanda sobre
-- pedido_unificado. El catálogo anterior la dejó como "proximamente" antes de
-- esas entregas; este cambio hace que las cuentas vean el módulo listo para
-- activar/configurar.
--
-- Es idempotente: se puede volver a ejecutar sin cambiar datos adicionales.
-- No crea entitlements ni activa Mesas para ningún restaurante.

UPDATE `modulo`
SET
  `estado_producto` = 'disponible',
  `activable` = true
WHERE `codigo` = 'mesas';
