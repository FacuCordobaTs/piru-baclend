/**
 * El scheduler es una compatibilidad acotada del Motor anterior. Growth no
 * crea filas en `campana_recompra` ni `cola_recompra`; sólo una cuenta que
 * conserva el entitlement físico legacy puede iniciar ese flujo automático.
 */
export function puedeCrearGoteoLegacy(tieneEntitlementMotorLegacy: boolean): boolean {
  return tieneEntitlementMotorLegacy
}
