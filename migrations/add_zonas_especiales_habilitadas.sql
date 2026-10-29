-- Interruptor maestro de zonas especiales (countries / barrios cerrados).
--
-- Apagado por defecto: un local que no lo active no muestra ni consulta nada
-- de countries en la tienda. La capacidad sigue dependiendo del módulo
-- `avisos_automaticos_whatsapp`; este flag sólo decide si se expone al cliente.
--
-- PRECONDICIÓN: backup lógico verificado. DDL en MySQL se confirma implícito.
-- Aplicar antes de desplegar el backend que lee la columna.

ALTER TABLE `restaurante`
  ADD COLUMN `zonas_especiales_habilitadas` BOOLEAN NOT NULL DEFAULT FALSE;
