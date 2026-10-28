-- Páginas propias: sitios con código React propio en `<username>.piru.app` (docs/PAGINAS_PROPIAS.md).
--
-- ADITIVA: sólo crea tablas nuevas. No toca `restaurante` ni nada existente; sin backfill (los
-- locales sin sitio siguen con su plantilla). Aplicar ANTES de desplegar el backend que monta
-- `/api/sitios` y `/api/public/carritos`. Sin estas tablas esas rutas responden 500 y el resto
-- del backend sigue igual.
--
-- Los instantes los escribe la aplicación con Drizzle y son DATETIME (sin conversión de zona).
--
-- PRECONDICIÓN: backup lógico verificado antes de ejecutar (MySQL confirma DDL de forma implícita).
-- `CREATE TABLE IF NOT EXISTS` hace la migración reintentable.

CREATE TABLE IF NOT EXISTS `sitio_tienda` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `slug` VARCHAR(63) NOT NULL,
  `username` VARCHAR(255) NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `estado` ENUM('activo', 'deshabilitado') NOT NULL DEFAULT 'activo',
  `meta` JSON NULL,
  `borrador` JSON NOT NULL,
  `borrador_actualizado_at` DATETIME(3) NOT NULL,
  `borrador_actualizado_por` INT NULL,
  `version_publicada_id` INT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sitio_tienda_restaurante` (`restaurante_id`),
  UNIQUE KEY `uq_sitio_tienda_slug` (`slug`),
  CONSTRAINT `fk_sitio_tienda_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS `sitio_version` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `sitio_id` INT NOT NULL,
  `restaurante_id` INT NOT NULL,
  `numero` INT NOT NULL,
  `archivos` JSON NOT NULL,
  `runtime_version` VARCHAR(10) NOT NULL,
  `bundle_key` VARCHAR(512) NOT NULL,
  `css_key` VARCHAR(512) NULL,
  `meta` JSON NULL,
  `build_log` TEXT NULL,
  `creado_por` INT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sitio_version_numero` (`sitio_id`, `numero`),
  CONSTRAINT `fk_sitio_version_sitio`
    FOREIGN KEY (`sitio_id`) REFERENCES `sitio_tienda` (`id`) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS `sitio_asset` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `sitio_id` INT NOT NULL,
  `restaurante_id` INT NOT NULL,
  `path` VARCHAR(255) NOT NULL,
  `sha` CHAR(64) NOT NULL,
  `r2_key` VARCHAR(512) NOT NULL,
  `content_type` VARCHAR(100) NOT NULL,
  `size` INT NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sitio_asset_path` (`sitio_id`, `path`),
  CONSTRAINT `fk_sitio_asset_sitio`
    FOREIGN KEY (`sitio_id`) REFERENCES `sitio_tienda` (`id`) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS `carrito_publico` (
  `id` VARCHAR(64) NOT NULL,
  `restaurante_id` INT NOT NULL,
  `sitio_id` INT NULL,
  `items` JSON NOT NULL,
  `contexto` JSON NULL,
  `return_url` VARCHAR(512) NULL,
  `expira_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_carrito_publico_expira` (`expira_at`),
  CONSTRAINT `fk_carrito_publico_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE
);
