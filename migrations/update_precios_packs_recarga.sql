-- Migration: recalibrar precios y cantidades de los packs de recarga (utility).
-- Depende de add_packs_recarga_mp.sql (packs ya seedeados en prod).
--
-- Precios/cantidades nuevos (decisión del usuario):
--   250 mensajes  -> $20.000
--   500 mensajes  -> $35.000
--   1.000 mensajes -> $60.000
--
-- Es SOLO datos (los packs son configuración editable sin deploy); el checkout
-- ya toma el precio SIEMPRE de la DB, nunca del cliente. Idempotente: matchea por
-- `orden` (estable desde el seed original), así que se puede correr varias veces.

UPDATE `pack_recarga`
  SET `nombre` = 'Recarga 250', `cantidad` = 250, `precio` = 20000.00
  WHERE `categoria_pack` = 'utility' AND `orden` = 1;

UPDATE `pack_recarga`
  SET `nombre` = 'Recarga 500', `cantidad` = 500, `precio` = 35000.00
  WHERE `categoria_pack` = 'utility' AND `orden` = 2;

UPDATE `pack_recarga`
  SET `nombre` = 'Recarga 1.000', `cantidad` = 1000, `precio` = 60000.00
  WHERE `categoria_pack` = 'utility' AND `orden` = 3;
