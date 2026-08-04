-- Migration: Claim flow (onboarding outbound). Ver docs/ROADMAP_CLAIM_FLOW.md
--
-- Aditiva y retrocompatible: agrega columnas nuevas a `restaurante` con defaults que no cambian
-- el comportamiento de las cuentas existentes (origen='self_serve'). Ejecutar en MySQL (prod).
-- Si alguna columna ya existe, omitir la sentencia que falle.

-- Cómo nació la cuenta. Default 'self_serve' → las cuentas actuales siguen igual.
ALTER TABLE `restaurante`
  ADD COLUMN `origen` ENUM('self_serve','outbound') NOT NULL DEFAULT 'self_serve' AFTER `requiere_suscripcion`;

-- Token del link de reclamo (único). Nullable: sólo las tiendas outbound con link lo tienen.
ALTER TABLE `restaurante`
  ADD COLUMN `claim_token` VARCHAR(64) NULL AFTER `origen`,
  ADD COLUMN `claim_token_expira` TIMESTAMP NULL AFTER `claim_token`,
  ADD COLUMN `claimed_at` TIMESTAMP NULL AFTER `claim_token_expira`;

-- Unicidad del token de reclamo (evita colisiones y sirve de lookup en el claim público).
ALTER TABLE `restaurante`
  ADD CONSTRAINT `uq_restaurante_claim_token` UNIQUE (`claim_token`);
</content>
