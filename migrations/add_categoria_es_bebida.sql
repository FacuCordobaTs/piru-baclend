-- Marca explícita para destacar bebidas en las comandas.
-- Aditiva y retrocompatible: todas las categorías existentes quedan como no-bebida.
ALTER TABLE categoria
  ADD COLUMN es_bebida BOOLEAN NOT NULL DEFAULT FALSE AFTER nombre;
