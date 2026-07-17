-- Permite desactivar un extra/agregado. Los desactivados no se ofrecen en la app cliente.
ALTER TABLE agregado ADD COLUMN activo BOOLEAN NOT NULL DEFAULT TRUE;
