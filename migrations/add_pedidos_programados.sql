ALTER TABLE restaurante
  ADD COLUMN permitir_pedidos_programados BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN usar_franjas_horario BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS franja_horario_pedido (
  id INT PRIMARY KEY AUTO_INCREMENT,
  restaurante_id INT NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  hora_inicio VARCHAR(5) NOT NULL,
  hora_fin VARCHAR(5) NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurante_id) REFERENCES restaurante(id)
);
