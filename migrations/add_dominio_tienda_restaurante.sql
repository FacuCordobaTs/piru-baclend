-- Dominio propio de la tienda por local.
--
-- `dominio_tienda`    = dominio público donde vive el storefront de ese local
--                       (sin protocolo). NULL = my.piru.app/<username>.
-- `dominio_plantillas` = base ya aprobada en las plantillas de Meta de ESE local.
--                       NULL = plantillas genéricas, cuyo botón tiene la base
--                       https://my.piru.app/ embebida y por lo tanto exige el
--                       username como primer segmento del path.
--
-- Los dos campos se resuelven por separado a propósito (ver
-- docs/PLANTILLAS_RECOMPRA_ALFAJOR.md): alfajor hoy tiene dominio_tienda propio
-- pero sigue mandando por las plantillas compartidas, así que su link público es
-- alfajorconpapas.com/c/<slug> mientras el path del botón es alfajor/c/<slug>.
--
-- PRECONDICIÓN: realizar y verificar un backup lógico antes de ejecutar.
-- El ALTER corre una sola vez (MySQL no soporta ADD COLUMN IF NOT EXISTS);
-- los UPDATE sí son idempotentes y pueden reejecutarse sin efecto.

START TRANSACTION;

ALTER TABLE `restaurante`
  ADD COLUMN `dominio_tienda` varchar(255) NULL AFTER `username`,
  ADD COLUMN `dominio_plantillas` varchar(255) NULL AFTER `dominio_tienda`;

UPDATE `restaurante` SET `dominio_tienda` = 'alfajorconpapas.com'
WHERE `id` = 6 OR LOWER(COALESCE(`username`, '')) IN ('alfajor', 'alfajorconpapas');

UPDATE `restaurante` SET `dominio_tienda` = 'che-milanesa.com'
WHERE `id` = 7 OR LOWER(COALESCE(`username`, '')) IN ('chemilanesa', 'che-milanesa');

COMMIT;

-- Verificación posterior (no modifica datos):
-- SELECT id, nombre, username, dominio_tienda, dominio_plantillas
-- FROM restaurante
-- WHERE id IN (6, 7)
--    OR LOWER(COALESCE(username, '')) IN ('alfajor', 'alfajorconpapas', 'chemilanesa', 'che-milanesa');
