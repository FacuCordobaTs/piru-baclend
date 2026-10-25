-- El módulo de Cupones es la activación vigente. Un flag histórico apagado,
-- sin control en la UI actual, podía ocultar el input aun con el módulo activo.
-- Repara esos locales sin activar módulos, cambiar cupos ni alterar cupones.
-- Idempotente. Aplicar también a los locales que ya tenían Cupones activado.
UPDATE restaurante r
JOIN restaurante_modulo rm ON rm.restaurante_id = r.id
JOIN modulo m ON m.id = rm.modulo_id
SET r.codigo_descuento_enabled = TRUE
WHERE m.codigo = 'codigos_descuento'
  AND m.activo = TRUE
  AND rm.estado IN ('activo', 'cancelacion_programada')
  AND (rm.vigente_hasta IS NULL OR rm.vigente_hasta > NOW())
  AND r.codigo_descuento_enabled = FALSE;
