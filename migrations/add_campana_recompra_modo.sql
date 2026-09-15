-- Motor de Recompra: modos manual y automático
-- Permite que una campaña activa opere en modo automático (envíos por Meta API con saldo de marketing)
-- o manual (el administrador copia los mensajes y los envía él mismo por WhatsApp).

ALTER TABLE `campana_recompra`
  ADD COLUMN `modo` VARCHAR(20) NOT NULL DEFAULT 'automatico';
