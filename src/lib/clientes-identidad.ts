import { and, asc, eq, sql } from 'drizzle-orm'
import { cliente } from '../db/schema'

export function normalizarTelefonoCliente(raw: string | null | undefined): string | null {
  const digitos = (raw ?? '').replace(/\D/g, '')
  return digitos.length >= 8 && digitos.length <= 20 ? digitos : null
}

export const columnasIndiceCliente = {
  id: cliente.id, nombre: cliente.nombre, telefono: cliente.telefono,
  telefonoNormalizado: cliente.telefonoNormalizado, updatedAt: cliente.updatedAt,
}

export async function indiceCliente(db: any, restauranteId: number, clienteId: number | null) {
  if (clienteId == null) return null
  const [fila] = await db.select(columnasIndiceCliente).from(cliente)
    .where(and(eq(cliente.restauranteId, restauranteId), eq(cliente.id, clienteId))).limit(1)
  return fila ?? null
}

/** Siempre dentro de una transacción. El lock funciona también durante el
 * rollout, antes de consolidar duplicados y habilitar el índice único. */
export async function bloquearIdentidadesRestaurante(tx: any, restauranteId: number) {
  if (!Number.isSafeInteger(restauranteId) || restauranteId <= 0) throw new Error('Restaurante inválido')
  await tx.execute(sql`SELECT id FROM restaurante WHERE id = ${restauranteId} FOR UPDATE`)
}

export async function resolverClienteParaPedido(tx: any, datos: {
  restauranteId: number; nombre?: string | null; telefono?: string | null; direccion?: string | null
}): Promise<typeof cliente.$inferSelect | null> {
  const telefonoNormalizado = normalizarTelefonoCliente(datos.telefono)
  const nombre = datos.nombre?.trim()
  if (!telefonoNormalizado || !nombre) return null
  await bloquearIdentidadesRestaurante(tx, datos.restauranteId)
  // Lectura bloqueante: no reutilizar un snapshot anterior a esperar el lock.
  const [existente] = await tx.select().from(cliente).where(and(
    eq(cliente.restauranteId, datos.restauranteId), eq(cliente.telefonoNormalizado, telefonoNormalizado),
  )).orderBy(asc(cliente.id)).limit(1).for('update')
  if (existente) {
    await tx.update(cliente).set({ nombre, telefono: datos.telefono!.trim(), updatedAt: new Date() })
      .where(and(eq(cliente.id, existente.id), eq(cliente.restauranteId, datos.restauranteId)))
    return { ...existente, nombre, telefono: datos.telefono!.trim(), updatedAt: new Date() }
  }
  // La dirección pertenece al snapshot del pedido; no se cambia el domicilio
  // del perfil por cada compra ni se fusiona por nombre.
  const [nuevo] = await tx.insert(cliente).values({
    restauranteId: datos.restauranteId, nombre, telefono: datos.telefono!.trim(), telefonoNormalizado,
  })
  const [fila] = await tx.select().from(cliente).where(eq(cliente.id, Number(nuevo.insertId))).limit(1)
  return fila
}
