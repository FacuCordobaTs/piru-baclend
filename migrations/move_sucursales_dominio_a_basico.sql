-- Migration: mover "múltiples sucursales" y "dominio propio" al plan Básico.
-- Antes: multisucursal era Intermedio+ ; dominio_propio era Avanzado.
-- Ahora: ambas son features del Básico (y, por herencia, de Intermedio y Avanzado).
--
-- Aditivo y retrocompatible: sólo agrega filas en plan_feature (idempotente por el
-- UNIQUE (plan_id, feature_key)) y actualiza las descripciones de los planes.
-- Ejecutar en MySQL (prod).

-- 1. Básico ahora habilita multisucursal + dominio_propio.
INSERT INTO `plan_feature` (`plan_id`, `feature_key`)
SELECT p.id, f.feature_key
FROM `plan` p
JOIN (
  SELECT 'multisucursal' AS feature_key
  UNION ALL SELECT 'dominio_propio'
) f
WHERE p.codigo = 'basico'
ON DUPLICATE KEY UPDATE `habilitado` = true;

-- 2. Intermedio ya tenía multisucursal; le agregamos dominio_propio para no perderlo
--    al bajarlo del Avanzado (cada plan lista su set completo de features).
INSERT INTO `plan_feature` (`plan_id`, `feature_key`)
SELECT p.id, 'dominio_propio'
FROM `plan` p
WHERE p.codigo = 'intermedio'
ON DUPLICATE KEY UPDATE `habilitado` = true;

-- (Avanzado ya tenía ambas: multisucursal + dominio_propio. Nada que hacer.)

-- 3. Descripciones alineadas al nuevo reparto.
UPDATE `plan`
SET `descripcion` = 'Recepción de pedidos, impresión de comandas, menú ilimitado, todos los métodos de pago, cupones, estadísticas y reportes, múltiples sucursales y dominio propio.'
WHERE `codigo` = 'basico';

UPDATE `plan`
SET `descripcion` = 'Todo lo del Básico más avisos automáticos al cliente por WhatsApp (200/mes), facturación ARCA, Rapiboy y estadísticas avanzadas.'
WHERE `codigo` = 'intermedio';

UPDATE `plan`
SET `descripcion` = 'Todo lo del Intermedio más 100 mensajes de marketing/mes y Motor de Recompra.'
WHERE `codigo` = 'avanzado';
