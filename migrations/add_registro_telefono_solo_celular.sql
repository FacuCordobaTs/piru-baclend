-- Ajuste al registro por WhatsApp: la cuenta se crea sólo con el celular.
-- (Aplicar DESPUÉS de add_registro_telefono_whatsapp.sql)
--
-- 1) restaurante.nombre pasa a ser nullable: al registrarse por WhatsApp no se pide
--    el nombre; se completa después en el onboarding.
-- 2) Se elimina registro_telefono.nombre: ya no se usa en el flujo de verificación.

ALTER TABLE `restaurante`
  MODIFY COLUMN `nombre` VARCHAR(255) NULL;

ALTER TABLE `registro_telefono`
  DROP COLUMN `nombre`;
