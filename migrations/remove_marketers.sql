-- Retira el canal de marketers: la operación de marketing vive en el panel del dueño
-- (admin/src/marketing/). Las cuentas, vínculos, comisiones y el registro de acciones de los
-- marketers se descartan; no hay datos que migrar.
-- Aplicar después de `add_marketers.sql`. Si esa migración nunca se aplicó, alcanza con no
-- aplicar ninguna de las dos partes de marketers (las columnas de tanda de `campana_recompra`
-- sí se usan y siguen en `add_marketers.sql`).
DROP TABLE IF EXISTS comision_marketer;
DROP TABLE IF EXISTS marketer_accion;
DROP TABLE IF EXISTS restaurante_marketer;
DROP TABLE IF EXISTS marketer;

ALTER TABLE campana_recompra DROP COLUMN marketer_id;
