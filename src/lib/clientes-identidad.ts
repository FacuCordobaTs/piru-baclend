import { and, asc, eq, sql } from 'drizzle-orm'
import { cliente } from '../db/schema'

export function normalizarTelefonoCliente(raw: string | null | undefined): string | null {
  const digitos = (raw ?? '').replace(/\D/g, '')
  return digitos.length >= 8 && digitos.length <= 20 ? digitos : null
}

export type ParticipantePedidoGrupo = { nombre: string; telefono: string }

/** El nombre del comensal llega como texto libre desde la tienda y puede variar
 * en mayúsculas, acentos o espacios entre el registro de conectados y cada ítem.
 * Se compara normalizado para no perder la identidad de un participante. */
export function normalizarNombreComensal(nombre?: string | null): string {
  return (nombre ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Roster de participantes de un pedido grupal (sala). Cada comensal se persiste
 * como `cliente` individual, por lo que la clave es el celular normalizado —la
 * misma identidad que usa `resolverClienteParaPedido`— y el nombre sólo funciona
 * como alias para vincular los ítems que no trajeron celular. La primera fuente
 * que aporta un dato gana, así que las fuentes del pedido (ítems y receptor) van
 * antes que las de contexto (`delPedido: false`): un conectado que no agregó
 * nada presta su celular para vincular nombres, pero no crea un cliente nuevo
 * porque no hay compra que lo verifique. */
export function construirRosterParticipantes(
  fuentes: { nombre?: string | null; telefono?: string | null; delPedido?: boolean }[],
): { participantes: Map<string, ParticipantePedidoGrupo>; porNombre: Map<string, string> } {
  const participantes = new Map<string, ParticipantePedidoGrupo>()
  const porNombre = new Map<string, string>()
  for (const fuente of fuentes) {
    const telefonoNormalizado = normalizarTelefonoCliente(fuente.telefono)
    const nombre = (fuente.nombre ?? '').trim()
    if (!telefonoNormalizado || !nombre) continue
    if (fuente.delPedido !== false && !participantes.has(telefonoNormalizado)) {
      participantes.set(telefonoNormalizado, { nombre, telefono: (fuente.telefono ?? '').trim() })
    }
    const claveNombre = normalizarNombreComensal(nombre)
    if (!porNombre.has(claveNombre)) porNombre.set(claveNombre, telefonoNormalizado)
  }
  return { participantes, porNombre }
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
