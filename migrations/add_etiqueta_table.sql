-- Crear tabla de etiquetas para productos
-- Cada etiqueta es única por restaurante (no puede haber dos productos con la misma etiqueta)
CREATE TABLE IF NOT EXISTS `etiqueta` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `restaurante_id` INT NOT NULL,
    `producto_id` INT NOT NULL,
    `nombre` VARCHAR(100) NOT NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`),
    FOREIGN KEY (`producto_id`) REFERENCES `producto`(`id`),
    UNIQUE INDEX `unique_restaurante_nombre` (`restaurante_id`, `nombre`)
);

