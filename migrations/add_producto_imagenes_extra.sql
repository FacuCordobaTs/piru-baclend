-- Galería opcional de producto: fotos adicionales a la portada (`imagen_url`).
-- Aplicar antes de desplegar el backend. Los productos existentes quedan sin galería (NULL).
ALTER TABLE producto
  ADD COLUMN imagenes_extra JSON NULL AFTER imagen_url;
