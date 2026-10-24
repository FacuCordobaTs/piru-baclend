-- Personalización opcional de la tienda. Aplicar antes de desplegar el backend.
ALTER TABLE restaurante ADD COLUMN tienda_config JSON NULL;
