-- Productos de ejemplo de las tiendas self-serve (ver backend/src/lib/productos-ejemplo.ts).
--
-- Al crear la tienda, el dueño responde dos preguntas (rubro y formas de entrega) y la carta arranca
-- con 3 productos de ejemplo de su rubro, marcados para que el panel los distinga y los pueda quitar
-- todos juntos sin tocar los productos que el dueño cargó.
--
-- ADITIVA: tres columnas nuevas con default, no cambia filas existentes. Aplicar ANTES de desplegar
-- el backend que las consume (Drizzle selecciona las columnas del schema: sin ellas, las consultas a
-- `producto` y `categoria` fallan).
--
-- PRECONDICIÓN: backup lógico verificado antes de ejecutar (MySQL confirma DDL de forma implícita).

ALTER TABLE `restaurante`
  ADD COLUMN `rubro` VARCHAR(30) NULL AFTER `plan_tienda`;

ALTER TABLE `producto`
  ADD COLUMN `es_ejemplo` BOOLEAN NOT NULL DEFAULT FALSE AFTER `orden`;

ALTER TABLE `categoria`
  ADD COLUMN `es_ejemplo` BOOLEAN NOT NULL DEFAULT FALSE AFTER `orden`;
