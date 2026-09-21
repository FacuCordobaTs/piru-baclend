-- Campañas de adquisición (`crecimiento`) deja de ser un módulo pago: pasa a
-- incluido, sin precio, y se activa desde la tab Adquisición con un clic.
--
-- `tipo_modulo` es lo que decide el camino de activación en `routes/modulos.ts`:
-- un módulo `incluido` se activa sin checkout (`PUT /:codigo/activar`) y
-- `resolverModulosFacturablesDeListado` sólo factura los `pago`. Con cambiar el
-- tipo, el módulo deja de aparecer en la próxima factura sin tocar
-- `pago_suscripcion`: los pagos ya registrados son historial y no se reescriben.
--
-- Normaliza además los entitlements que quedaron en un estado de cobro. Con el
-- módulo incluido no hay período pago que conservar, y esos estados dejan al
-- local en una pantalla sin salida: `pendiente_pago` ofrece "Volver al pago"
-- contra un checkout que el backend rechaza por estar incluido, y
-- `cancelacion_programada` ofrece "Reactivar módulo" contra la misma negativa.
-- Los locales que no lo tenían no se activan solos: lo activan desde la tab.
--
-- Es idempotente: se puede volver a ejecutar sin problemas.

UPDATE `modulo`
SET
  `tipo_modulo` = 'incluido',
  `precio_mensual` = 0.00,
  `activable` = true,
  `activo` = true
WHERE `codigo` = 'crecimiento';

UPDATE `restaurante_modulo` rm
JOIN `modulo` m ON m.`id` = rm.`modulo_id`
SET
  rm.`precio_mensual_congelado` = NULL,
  rm.`vigente_hasta` = NULL,
  rm.`cancelar_al_fin_periodo` = false
WHERE m.`codigo` = 'crecimiento';

-- El resto conserva su estado (`activo` sigue activo, `inactivo` sigue esperando
-- que el dueño lo prenda) pero pierde el precio congelado: ya no hay monto que
-- facturar ni que mostrar.
UPDATE `restaurante_modulo` rm
JOIN `modulo` m ON m.`id` = rm.`modulo_id`
SET rm.`precio_mensual_congelado` = NULL
WHERE m.`codigo` = 'crecimiento';
