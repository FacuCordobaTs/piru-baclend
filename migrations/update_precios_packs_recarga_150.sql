-- Migration: aumentar un 50% el precio de todos los packs de recarga (utility y marketing).
-- Depende de add_packs_recarga_mp.sql y update_modelo_3_planes.sql (packs ya seedeados en prod).
--
-- Decisión del usuario: precio nuevo = precio vigente x 1.5.
--   utility   250 mensajes  -> $30.000  (antes $20.000)
--   utility   500 mensajes  -> $52.500  (antes $35.000)
--   utility 1.000 mensajes  -> $90.000  (antes $60.000)
--   marketing   100 envíos  -> $27.000  (antes $18.000)
--   marketing   500 envíos  -> $120.000 (antes $80.000)
--   marketing 1.000 envíos  -> $210.000 (antes $140.000)
--
-- Es SOLO datos (los packs son configuración editable sin deploy); el checkout
-- ya toma el precio SIEMPRE de la DB, nunca del cliente. Idempotente: matchea por
-- `categoria_pack` + `orden` (estable desde el seed original) y fija valores absolutos,
-- así que se puede correr varias veces sin acumular aumentos.

UPDATE `pack_recarga`
  SET `precio` = 30000.00, `updated_at` = CURRENT_TIMESTAMP
  WHERE `categoria_pack` = 'utility' AND `orden` = 1;

UPDATE `pack_recarga`
  SET `precio` = 52500.00, `updated_at` = CURRENT_TIMESTAMP
  WHERE `categoria_pack` = 'utility' AND `orden` = 2;

UPDATE `pack_recarga`
  SET `precio` = 90000.00, `updated_at` = CURRENT_TIMESTAMP
  WHERE `categoria_pack` = 'utility' AND `orden` = 3;

UPDATE `pack_recarga`
  SET `precio` = 27000.00, `updated_at` = CURRENT_TIMESTAMP
  WHERE `categoria_pack` = 'marketing' AND `orden` = 1;

UPDATE `pack_recarga`
  SET `precio` = 120000.00, `updated_at` = CURRENT_TIMESTAMP
  WHERE `categoria_pack` = 'marketing' AND `orden` = 2;

UPDATE `pack_recarga`
  SET `precio` = 210000.00, `updated_at` = CURRENT_TIMESTAMP
  WHERE `categoria_pack` = 'marketing' AND `orden` = 3;
