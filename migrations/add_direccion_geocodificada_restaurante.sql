ALTER TABLE restaurante
  ADD COLUMN direccion_texto VARCHAR(512) DEFAULT NULL AFTER direccion,
  ADD COLUMN direccion_lat DECIMAL(10, 7) DEFAULT NULL AFTER direccion_texto,
  ADD COLUMN direccion_lng DECIMAL(10, 7) DEFAULT NULL AFTER direccion_lat;
