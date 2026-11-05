-- Retira Rapiboy del catálogo visible de módulos.
-- No borra la fila ni los entitlements existentes: las integraciones ya
-- configuradas siguen funcionando con su gate, pero el módulo deja de
-- ofrecerse para activar y no aparece en /mis-modulos.
UPDATE `modulo`
SET `activo` = false
WHERE `codigo` = 'rapiboy';
