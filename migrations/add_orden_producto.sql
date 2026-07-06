-- Orden manual de aparición de los productos dentro de su categoría (menor = primero)
ALTER TABLE producto ADD COLUMN orden INT NOT NULL DEFAULT 0;
