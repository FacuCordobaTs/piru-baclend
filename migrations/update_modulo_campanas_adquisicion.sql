-- Actualiza el módulo crecimiento para pasar a llamarse "Campañas de adquisición"
-- y ajusta su precio mensual de $70.000 a $20.000, asegurando que quede activo y activable.
--
-- Es idempotente: se puede volver a ejecutar sin problemas.

UPDATE `modulo`
SET
  `nombre` = 'Campañas de adquisición',
  `descripcion` = 'Medí ventas desde Instagram, TikTok, Meta Ads y Packaging con enlaces y carritos precargados.',
  `precio_mensual` = 20000.00,
  `activable` = true,
  `activo` = true
WHERE `codigo` = 'crecimiento';
