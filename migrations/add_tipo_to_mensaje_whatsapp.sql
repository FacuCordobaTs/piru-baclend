-- Agrega tipo de mensaje a la tabla mensaje_whatsapp para poder identificar
-- si el mensaje enviado fue un pedido_confirmado o pedido_despachado
ALTER TABLE `mensaje_whatsapp`
  ADD COLUMN `tipo_mensaje` enum('pedido_confirmado','pedido_despachado') DEFAULT NULL;
