-- Datos de ejemplo de la demo de prospección (panel de la demo, ver docs/AUTH_AND_ONBOARDING.md).
--
-- El fundador arma la tienda de un prospecto y, al terminar, un lote deja en ella clientes, pedidos,
-- campañas y un cupón de ejemplo (todos con la marca "EJEMPLO" en el nombre) para que el panel no se
-- vea vacío cuando el dueño entra desde el botón "Ver tu panel de administrador" de la tienda demo.
-- Esta tabla recuerda qué se sembró (ids por tipo) para poder borrarlo en un solo paso sin tocar nada
-- que sea del dueño, y si ya se borró, para no volver a sembrarlo solo.
--
-- ADITIVA: sólo crea una tabla nueva. No toca `restaurante` ni nada existente. Aplicar ANTES de
-- desplegar el backend que la consume (sin ella, sembrar/borrar datos de ejemplo falla; la demo de la
-- tienda y el resto del panel no dependen de la tabla).
--
-- Los instantes los escribe la aplicación con Drizzle y son DATETIME (sin conversión de zona), igual
-- que en `mp_conexion_qr` y `marketer`. Nunca compararlos en SQL con NOW().
--
-- PRECONDICIÓN: backup lógico verificado antes de ejecutar (MySQL confirma DDL de forma implícita).
-- `CREATE TABLE IF NOT EXISTS` hace la migración reintentable.

CREATE TABLE IF NOT EXISTS `datos_ejemplo` (
  `restaurante_id` INT NOT NULL,
  `sembrado_at` DATETIME NOT NULL,
  `borrado_at` DATETIME NULL DEFAULT NULL,
  `registros` JSON NOT NULL,
  PRIMARY KEY (`restaurante_id`),
  CONSTRAINT `fk_datos_ejemplo_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE
);
