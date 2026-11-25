-- Recompra por tandas con sucursales: cada tanda sale desde un número (el de una sucursal o el
-- del local) y sólo incluye a los clientes que pidieron ahí.
--
-- ADITIVA: tres columnas nulables en `recompra_tanda`. Las tandas existentes quedan con
-- `alcance` NULL, que se lee como `todo` (toda la base, como hasta ahora).
--
-- Ver docs/CUSTOMERS_AND_GROWTH.md ("Recompra por tandas" → "Sucursales").

ALTER TABLE `recompra_tanda`
  ADD COLUMN `alcance` ENUM('todo','local','sucursal') NULL AFTER `con_puntos`,
  ADD COLUMN `sucursal_id` INT NULL AFTER `alcance`,
  ADD COLUMN `numero_envio` VARCHAR(50) NULL AFTER `sucursal_id`,
  ADD CONSTRAINT `fk_recompra_tanda_sucursal` FOREIGN KEY (`sucursal_id`) REFERENCES `sucursal` (`id`) ON DELETE SET NULL;
