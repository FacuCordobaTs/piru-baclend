-- Clave idempotente de las tiendas demo que crea el servidor de prospección (`/api/prospeccion/*`).
--
-- Reintentar la creación con el mismo `prospecto_ref` no duplica la tienda. Sólo la usan las
-- tiendas creadas por ese canal: el resto de los locales queda en NULL (el índice único admite
-- varios NULL).
--
-- ADITIVA: agrega una columna nullable y un índice. Aplicar ANTES de desplegar el backend que la
-- consume; sin ella, `POST /api/prospeccion/tienda-desde-json` falla.
ALTER TABLE `restaurante`
  ADD COLUMN `prospecto_ref` VARCHAR(64) NULL,
  ADD UNIQUE KEY `restaurante_prospecto_ref_unique` (`prospecto_ref`);
