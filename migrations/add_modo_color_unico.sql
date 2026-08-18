-- Modo de identidad visual con un único color de acento. Las cuentas existentes
-- conservan el tema histórico de dos colores hasta que lo activen en Ajustes.
ALTER TABLE restaurante
  ADD COLUMN usar_color_unico BOOLEAN NOT NULL DEFAULT FALSE AFTER color_secundario;
