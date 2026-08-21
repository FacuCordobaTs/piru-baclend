-- Google Maps permanece como comportamiento predeterminado para todos los locales existentes.
ALTER TABLE restaurante
  ADD COLUMN direccion_solo_texto BOOLEAN NOT NULL DEFAULT FALSE;
