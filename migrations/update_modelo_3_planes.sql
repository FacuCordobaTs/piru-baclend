-- Migration: Modelo 3 de negocio (fuente de verdad actual).
-- Cambios vs Modelo 2:
--   1. Precios: Intermedio $80.000 -> $50.000 ; Avanzado $200.000 -> $120.000.
--   2. Utility incluido: Intermedio 500 -> 200 ; Avanzado (antes "ilimitado") -> 200.
--   3. Se termina el "ilimitado": NINGÚN plan es ilimitado (cada mensaje tiene costo real en Meta).
--   4. Nuevo bucket MARKETING incluido: el Avanzado incluye 100 mensajes de marketing/mes
--      (degustación del Motor de Recompra).
--   5. Nuevos packs de campaña (marketing) comprables: +100/$18.000, +500/$80.000, +1.000/$140.000.
--
-- Aditivo y retrocompatible: agrega columnas nuevas con default 0 y actualiza datos (precio/
-- mensajes son configuración editable sin deploy). Ejecutar en MySQL (prod). Si algo ya existe,
-- omitir la sentencia que falle.

-- 1. Columna: mensajes marketing incluidos por ciclo en la definición del plan.
ALTER TABLE `plan`
  ADD COLUMN `mensajes_marketing_incluidos` INT NOT NULL DEFAULT 0 AFTER `mensajes_incluidos`;

-- 2. Columna: cupo marketing del ciclo actual en el wallet (se resetea por ciclo, sobrante se pierde).
ALTER TABLE `saldo_mensajes`
  ADD COLUMN `marketing_incluidos_restantes` INT NOT NULL DEFAULT 0 AFTER `utility_recarga_saldo`;

-- 3. Recalibrar los planes al Modelo 3 (precio, utility incluido, marketing incluido, fin del ilimitado).
UPDATE `plan`
  SET `precio_mensual` = 20000.00, `mensajes_incluidos` = 0, `mensajes_marketing_incluidos` = 0, `mensajes_ilimitados` = false,
      `descripcion` = 'Recepción de pedidos, impresión de comandas, menú ilimitado, todos los métodos de pago, cupones, estadísticas y reportes.'
  WHERE `codigo` = 'basico';

UPDATE `plan`
  SET `precio_mensual` = 50000.00, `mensajes_incluidos` = 200, `mensajes_marketing_incluidos` = 0, `mensajes_ilimitados` = false,
      `descripcion` = 'Todo lo del Básico más avisos automáticos al cliente por WhatsApp (200/mes), facturación ARCA, Rapiboy, múltiples sucursales y estadísticas avanzadas.'
  WHERE `codigo` = 'intermedio';

UPDATE `plan`
  SET `precio_mensual` = 120000.00, `mensajes_incluidos` = 200, `mensajes_marketing_incluidos` = 100, `mensajes_ilimitados` = false,
      `descripcion` = 'Todo lo del Intermedio más 100 mensajes de marketing/mes, dominio propio y Motor de Recompra.'
  WHERE `codigo` = 'avanzado';

-- 4. Packs de campaña (marketing). Costo Meta por mensaje ~$93,32 (revisar mensual).
--    Unique key en (categoria_pack, orden) para que el seed sea idempotente (ON DUPLICATE KEY).
--    Si la key ya existe, omitir esta sentencia (fallará y es esperable en re-runs).
ALTER TABLE `pack_recarga`
  ADD UNIQUE KEY `uq_pack_categoria_orden` (`categoria_pack`, `orden`);

INSERT INTO `pack_recarga` (`categoria_pack`, `nombre`, `cantidad`, `precio`, `orden`, `activo`)
VALUES
  ('marketing', 'Campaña 100',   100,  18000.00,  1, true),
  ('marketing', 'Campaña 500',   500,  80000.00,  2, true),
  ('marketing', 'Campaña 1.000', 1000, 140000.00, 3, true)
ON DUPLICATE KEY UPDATE `nombre` = VALUES(`nombre`), `cantidad` = VALUES(`cantidad`), `precio` = VALUES(`precio`), `activo` = true;
