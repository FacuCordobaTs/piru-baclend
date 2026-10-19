-- Aplicar antes de desplegar el backend. Los productos existentes siguen vendiéndose normalmente.
ALTER TABLE producto
  ADD COLUMN solo_canje_puntos BOOLEAN NOT NULL DEFAULT FALSE;
