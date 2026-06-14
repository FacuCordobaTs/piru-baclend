-- Add anotadoManualmente flag to pedido_unificado (pedidos del POS local, sin comisión)
ALTER TABLE pedido_unificado ADD COLUMN anotado_manualmente BOOLEAN NOT NULL DEFAULT FALSE;
