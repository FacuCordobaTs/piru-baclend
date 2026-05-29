-- Add grupal flag to pedido_unificado and clienteNombre to item_pedido_unificado
ALTER TABLE pedido_unificado ADD COLUMN grupal BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE item_pedido_unificado ADD COLUMN cliente_nombre VARCHAR(255) NULL;
