-- Orden manual de aparición de las categorías en la carta (menor = primero).
-- Aditivo y retrocompatible: las categorías existentes conservan orden 0 y los
-- clientes usan el nombre como desempate hasta que el restaurante las reordena.
ALTER TABLE categoria ADD COLUMN orden INT NOT NULL DEFAULT 0;

CREATE INDEX idx_categoria_restaurante_orden
  ON categoria (restaurante_id, orden, id);
