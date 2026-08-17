-- Agrega `mesa` como tercer tipo real de pedido unificado.
--
-- Orden seguro: primero se amplía el ENUM y luego se reclasifican los pedidos
-- creados por la implementación transitoria (takeaway + consumo_en_local).
-- La operación es reintentable: MODIFY no elimina ningún valor y el UPDATE no
-- vuelve a tocar filas ya migradas.
--
-- PRECONDICIÓN: verificar un backup lógico. ALTER TABLE hace commit implícito en
-- MySQL; para volver atrás hay que restaurar el backup o reclasificar `mesa` a
-- `takeaway` antes de contraer el ENUM.

ALTER TABLE `pedido_unificado`
  MODIFY COLUMN `tipo` ENUM('delivery', 'takeaway', 'mesa') NOT NULL;

UPDATE `pedido_unificado`
SET `tipo` = 'mesa'
WHERE `tipo` = 'takeaway'
  AND `consumo_en_local` = true
  AND `mesa_local_id` IS NOT NULL;
