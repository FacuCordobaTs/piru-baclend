-- Días de reparto de las zonas especiales (countries / barrios cerrados).
--
-- `dias_reparto` guarda los días como "0,3" (0 = domingo, igual que Date#getDay).
-- La zona sólo se ofrece en la tienda esos días y `hora_inicio`/`hora_fin` pasan a
-- delimitar cuándo se aceptan pre-pedidos; el horario de entrega se avisa por
-- WhatsApp. El default conserva el comportamiento anterior (todos los días).
--
-- PRECONDICIÓN: backup lógico verificado. DDL en MySQL se confirma implícito.
-- Aplicar antes de desplegar el backend que lee la columna.

ALTER TABLE `zona_especial`
  ADD COLUMN `dias_reparto` VARCHAR(20) NOT NULL DEFAULT '0,1,2,3,4,5,6' AFTER `hora_fin`;
