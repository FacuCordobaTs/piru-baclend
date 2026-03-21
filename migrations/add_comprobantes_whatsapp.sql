-- Número WhatsApp para que clientes envíen comprobantes (transferencia manual), distinto del usado por la API de notificaciones al restaurante.
ALTER TABLE `restaurante`
  ADD COLUMN `comprobantes_whatsapp` VARCHAR(50) NULL AFTER `whatsapp_number`;
