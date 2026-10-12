-- Entradas al panel de la demo de prospección (ver docs/AUTH_AND_ONBOARDING.md, "Panel de la demo").
--
-- El botón "Ver tu panel de administrador" de la tienda demo abre `admin/demo/:username`, que pide
-- una sesión a `POST /api/demo-panel/sesion`. Cada vez que se entrega una sesión se anota acá: cuándo
-- entró por primera y por última vez y cuántas veces. Es la señal que le dice al fundador a quién
-- escribirle y cuándo; la lee el panel interno. Una fila por local; se borra con el local.
--
-- ADITIVA: sólo crea una tabla nueva. No toca `restaurante` ni nada existente. Aplicar ANTES de
-- desplegar el backend que la consume; sin ella la demo igual abre (la entrada no se anota y el
-- listado de interno la muestra vacía).
--
-- Los instantes los escribe la aplicación con Drizzle y son DATETIME (sin conversión de zona), igual
-- que en `datos_ejemplo`. Nunca compararlos en SQL con NOW().
--
-- PRECONDICIÓN: backup lógico verificado antes de ejecutar (MySQL confirma DDL de forma implícita).
-- `CREATE TABLE IF NOT EXISTS` hace la migración reintentable.

CREATE TABLE IF NOT EXISTS `demo_panel_visita` (
  `restaurante_id` INT NOT NULL,
  `primera_entrada_at` DATETIME NOT NULL,
  `ultima_entrada_at` DATETIME NOT NULL,
  `entradas` INT NOT NULL DEFAULT 1,
  PRIMARY KEY (`restaurante_id`),
  CONSTRAINT `fk_demo_panel_visita_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE
);
