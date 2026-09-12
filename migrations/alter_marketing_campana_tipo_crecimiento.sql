-- Migración: Ampliación de tipos de campaña en marketing_campana y provisión de campañas maestras
-- Permite que 'lo_mismo' y 'reactivacion' existan como tipos de primer orden en la tabla marketing_campana.

ALTER TABLE `marketing_campana` 
  MODIFY COLUMN `tipo` ENUM('adquisicion', 'recompra', 'retencion', 'lo_mismo', 'reactivacion') NOT NULL;

-- Sembrar persistentemente las dos micro-campañas maestras para todos los restaurantes existentes
INSERT IGNORE INTO `marketing_campana` (`restaurante_id`, `nombre`, `slug`, `tipo`, `estado`, `destino_tipo`)
SELECT id, '¿Lo mismo de siempre?', 'lo-mismo', 'lo_mismo', 'activa', 'tienda'
FROM restaurante;

INSERT IGNORE INTO `marketing_campana` (`restaurante_id`, `nombre`, `slug`, `tipo`, `estado`, `destino_tipo`, `descuento_producto_porcentaje`)
SELECT id, 'Reactivación con Descuento', 'reactivacion', 'reactivacion', 'activa', 'tienda', 10
FROM restaurante;
