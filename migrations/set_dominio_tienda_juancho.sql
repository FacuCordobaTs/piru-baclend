-- Dominio público del storefront single-tenant del restaurante 39.
-- Los links de campañas y recompra deben seguir funcionando al cambiar username.
UPDATE `restaurante`
SET `dominio_tienda` = 'juanchosandwicheria.com'
WHERE `id` = 39;
