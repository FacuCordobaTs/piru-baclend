-- MVP marketers: aplicar antes del backend. DATETIME conserva instantes según el pool UTC-3.
-- Cuentas de los marketers. Las crea interno; el marketer activa la suya con el link.
CREATE TABLE marketer (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  telefono VARCHAR(50) NULL,
  password_hash VARCHAR(255) NULL,                -- NULL hasta que active la cuenta
  activacion_token_hash CHAR(64) NULL,            -- sha256 del token del link
  activacion_expira_at DATETIME NULL,
  codigo VARCHAR(32) NOT NULL,                    -- código de partner, en mayúsculas
  comision_porcentaje DECIMAL(5,2) NOT NULL DEFAULT 20.00,  -- a confirmar (§14)
  datos_cobro VARCHAR(255) NULL,                  -- alias o CBU para transferirle
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_acceso_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_marketer_email (email),
  UNIQUE KEY uq_marketer_codigo (codigo),
  CONSTRAINT chk_marketer_comision CHECK (comision_porcentaje BETWEEN 0 AND 100)
);

-- Vínculo vigente local ↔ marketer: uno por local. Dar acceso a otro actualiza la fila.
CREATE TABLE restaurante_marketer (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurante_id INT NOT NULL,
  marketer_id INT NOT NULL,
  estado ENUM('activo','revocado') NOT NULL DEFAULT 'activo',
  origen ENUM('interno','duenio','referido') NOT NULL,
  comision_porcentaje DECIMAL(5,2) NULL,          -- override por local; NULL = el del marketer
  activado_at DATETIME NOT NULL,
  revocado_at DATETIME NULL,
  revocado_por ENUM('duenio','interno','marketer') NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_restaurante_marketer_restaurante (restaurante_id),
  KEY idx_restaurante_marketer_marketer (marketer_id, estado),
  CONSTRAINT fk_restaurante_marketer_restaurante FOREIGN KEY (restaurante_id) REFERENCES restaurante(id) ON DELETE CASCADE,
  CONSTRAINT fk_restaurante_marketer_marketer FOREIGN KEY (marketer_id) REFERENCES marketer(id)
);

-- Una comisión por factura aprobada: el índice único es la idempotencia.
CREATE TABLE comision_marketer (
  id INT AUTO_INCREMENT PRIMARY KEY,
  marketer_id INT NOT NULL,
  restaurante_id INT NOT NULL,
  pago_suscripcion_id INT NOT NULL,
  base_comisionable DECIMAL(10,2) NOT NULL,       -- monto_base + monto_modulos, sin recargas
  porcentaje DECIMAL(5,2) NOT NULL,               -- congelado al generarla
  monto DECIMAL(10,2) NOT NULL,
  estado ENUM('pendiente','pagada','anulada') NOT NULL DEFAULT 'pendiente',
  pagada_at DATETIME NULL,
  referencia_pago VARCHAR(255) NULL,
  nota VARCHAR(255) NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_comision_marketer_pago (pago_suscripcion_id),
  KEY idx_comision_marketer_marketer (marketer_id, estado, created_at),
  CONSTRAINT fk_comision_marketer_marketer FOREIGN KEY (marketer_id) REFERENCES marketer(id),
  CONSTRAINT fk_comision_marketer_restaurante FOREIGN KEY (restaurante_id) REFERENCES restaurante(id),
  CONSTRAINT fk_comision_marketer_pago FOREIGN KEY (pago_suscripcion_id) REFERENCES pago_suscripcion(id)
);

-- Qué cambió el marketer en cada local (sólo mutaciones; la ruta sin query string).
CREATE TABLE marketer_accion (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  marketer_id INT NOT NULL,
  restaurante_id INT NOT NULL,
  metodo VARCHAR(8) NOT NULL,
  ruta VARCHAR(255) NOT NULL,
  status SMALLINT NULL,
  created_at DATETIME NOT NULL,
  KEY idx_marketer_accion_restaurante (restaurante_id, created_at),
  KEY idx_marketer_accion_marketer (marketer_id, created_at)
);

-- Tandas de día flojo y texto libre del modo manual.
ALTER TABLE campana_recompra
  ADD COLUMN fecha_objetivo VARCHAR(10) NULL,     -- 'YYYY-MM-DD' de Argentina
  ADD COLUMN hora_objetivo TINYINT NULL,
  ADD COLUMN mensaje_personalizado TEXT NULL,     -- sólo modo manual
  ADD COLUMN descuento_porcentaje TINYINT NULL,   -- sólo modo manual: 0 o 5–30
  ADD COLUMN marketer_id INT NULL;                -- quién la programó; NULL = el dueño

-- Manual primero. Registrar este resultado antes de aplicar el UPDATE (sin DB local).
SELECT COUNT(*) AS locales_a_migrar_a_manual
FROM config_motor_recompra c JOIN restaurante r ON r.id = c.restaurante_id
WHERE c.modo = 'automatico'
  AND (r.whatsapp_access_token IS NULL OR r.whatsapp_enabled = FALSE);

-- Manual primero.
ALTER TABLE config_motor_recompra ALTER COLUMN modo SET DEFAULT 'manual';
UPDATE config_motor_recompra c
  JOIN restaurante r ON r.id = c.restaurante_id
  SET c.modo = 'manual'
  WHERE c.modo = 'automatico'
    AND (r.whatsapp_access_token IS NULL OR r.whatsapp_enabled = FALSE);
