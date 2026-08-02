-- Descuento anual por plan: al pagar la cuota por año se aplica un % de descuento
-- (tope de negocio: 20%). Columna en la tabla `plan` para calibrarla sin deploy.
-- El backend clampea el valor a [0, 20] al cobrar (montoPorCiclo).
-- Aditivo y retrocompatible: columna nueva con default. Los planes existentes
-- arrancan con el descuento anual máximo (20%) para que la opción anual sea
-- atractiva de entrada; ajustable después con `UPDATE plan SET descuento_anual = ...`.

ALTER TABLE `plan`
  ADD COLUMN `descuento_anual` INT NOT NULL DEFAULT 20;
