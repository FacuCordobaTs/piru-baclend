/**
 * Siembra y borra los datos de ejemplo de la demo de prospección. El plan (qué filas) es puro y vive
 * en `datos-ejemplo.ts`; acá sólo se escriben. Ver docs/AUTH_AND_ONBOARDING.md ("Panel de la demo").
 *
 * Invariantes:
 *   - sólo en tiendas que todavía son un prospecto sin reclamar: nunca se mezclan datos de ejemplo
 *     con la operación de un local real;
 *   - una sola corrida por vez: se serializa con el bloqueo de la fila del local (como el alta de la
 *     prueba), así dos entradas simultáneas a la demo no duplican nada;
 *   - los datos son del día: cada día que alguien entra, lo sembrado se rehace para que "hoy" tenga
 *     pedidos de hoy y quien "se está yendo" siga yéndose. Si el dueño los borró, no vuelven solos;
 *   - borrar es borrar todo lo de ejemplo, también lo que el panel colgó de ellos (enlaces, mensajes,
 *     pedidos de un cliente de ejemplo), y nada más.
 */

import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, inArray, isNull, or } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import {
  campanaRecompraCliente,
  cliente,
  codigoDescuento,
  colaRecompra,
  datosEjemplo,
  itemPedidoUnificado,
  marketingCampana,
  marketingContacto,
  marketingEnlace,
  marketingEvento,
  marketingSesion,
  mensajeWhatsapp,
  modulo,
  pago,
  pedidoMarketingAtribucion,
  pedidoUnificado,
  pedidoUnificadoAuditoria,
  producto,
  recuperoCliente,
  restaurante,
  restauranteModulo,
  sucursal,
  transaccionPuntos,
  varianteProducto,
  whatsappConversacion,
} from '../db/schema'
import { esProspectoSinReclamar } from './demo-panel'
import { inicioDiaAR, planificarDatosEjemplo, type ProductoEjemplo } from './datos-ejemplo'
import { nuevoRequestIdEjemplo } from './pedido-ejemplo'

type Db = MySql2Database<Record<string, never>>

/** Módulos incluidos (gratis) que las campañas y los cupones de ejemplo necesitan para verse. */
const MODULOS_INCLUIDOS_DEL_EJEMPLO = ['crecimiento', 'codigos_descuento']

export interface RegistrosEjemplo {
  clientes: number[]
  pedidos: number[]
  campanas: number[]
  cupones: number[]
}

export type ResultadoSiembra =
  | { estado: 'sembrado'; clientes: number; pedidos: number; campanas: number }
  /** Ya están sembrados hoy. */
  | { estado: 'vigente' }
  /** El dueño los borró: no se vuelven a sembrar solos. */
  | { estado: 'borrado' }
  /** No es un prospecto sin reclamar. */
  | { estado: 'no_aplica' }
  | { estado: 'sin_productos' }
  /** Ya tiene clientes o pedidos de verdad. */
  | { estado: 'con_datos_propios' }

const unicos = (ids: number[]) => Array.from(new Set(ids))

function enBloques<T>(filas: T[], tamano = 100): T[][] {
  const bloques: T[][] = []
  for (let i = 0; i < filas.length; i += tamano) bloques.push(filas.slice(i, i + tamano))
  return bloques
}

const dos = (n: number) => n.toFixed(2)

/** Los productos reales del local con la primera opción de cada grupo de variantes. */
async function cargarProductos(db: Db, restauranteId: number): Promise<ProductoEjemplo[]> {
  const filas = await db
    .select({ id: producto.id, nombre: producto.nombre, precio: producto.precio })
    .from(producto)
    .where(
      and(
        eq(producto.restauranteId, restauranteId),
        eq(producto.activo, true),
        isNull(producto.eventoSucursalId),
      ),
    )
    .orderBy(asc(producto.orden), asc(producto.id))
  if (filas.length === 0) return []
  const variantes = await db
    .select({
      id: varianteProducto.id,
      productoId: varianteProducto.productoId,
      nombre: varianteProducto.nombre,
      precio: varianteProducto.precio,
      grupo: varianteProducto.grupo,
    })
    .from(varianteProducto)
    .where(
      and(
        inArray(
          varianteProducto.productoId,
          filas.map((f) => f.id),
        ),
        eq(varianteProducto.activo, true),
      ),
    )
    .orderBy(asc(varianteProducto.id))
  const primera = (productoId: number, grupo: number) => {
    const v = variantes.find((x) => x.productoId === productoId && x.grupo === grupo)
    return v ? { id: v.id, nombre: v.nombre, precio: Number(v.precio) } : null
  }
  return filas.map((f) => ({
    id: f.id,
    nombre: f.nombre,
    precio: Number(f.precio),
    variante: primera(f.id, 1),
    varianteSecundaria: primera(f.id, 2),
  }))
}

/**
 * Borra lo sembrado y lo que el panel colgó de ello. El orden respeta las claves foráneas, varias
 * sin ON DELETE: atribuciones y eventos → pedidos → enlaces y cola de recompra → clientes → sesiones →
 * campañas → cupones. Cada borrado lleva el `restaurante_id`: un id mal guardado no toca a otro local.
 */
export async function borrarRegistros(tx: Db, restauranteId: number, registros: RegistrosEjemplo) {
  const clientes = unicos(registros.clientes ?? [])
  const campanas = unicos(registros.campanas ?? [])
  const cupones = unicos(registros.cupones ?? [])
  let pedidos = unicos(registros.pedidos ?? [])

  // También los pedidos que el panel dejó a nombre de un cliente de ejemplo (un pedido de prueba
  // anotado en el POS): el cliente no se puede borrar con pedidos colgando.
  if (clientes.length > 0) {
    const ajenos = await tx
      .select({ id: pedidoUnificado.id })
      .from(pedidoUnificado)
      .where(and(eq(pedidoUnificado.restauranteId, restauranteId), inArray(pedidoUnificado.clienteId, clientes)))
    pedidos = unicos([...pedidos, ...ajenos.map((p) => p.id)])
  }

  if (pedidos.length > 0) {
    await tx
      .delete(pedidoMarketingAtribucion)
      .where(
        and(
          eq(pedidoMarketingAtribucion.restauranteId, restauranteId),
          inArray(pedidoMarketingAtribucion.pedidoUnificadoId, pedidos),
        ),
      )
    await tx
      .update(marketingEvento)
      .set({ pedidoUnificadoId: null })
      .where(
        and(eq(marketingEvento.restauranteId, restauranteId), inArray(marketingEvento.pedidoUnificadoId, pedidos)),
      )
    await tx.delete(pago).where(inArray(pago.pedidoUnificadoId, pedidos))
    await tx
      .delete(mensajeWhatsapp)
      .where(and(eq(mensajeWhatsapp.restauranteId, restauranteId), inArray(mensajeWhatsapp.pedidoUnificadoId, pedidos)))
    await tx
      .update(whatsappConversacion)
      .set({ pedidoUnificadoId: null })
      .where(
        and(
          eq(whatsappConversacion.restauranteId, restauranteId),
          inArray(whatsappConversacion.pedidoUnificadoId, pedidos),
        ),
      )
    await tx.delete(pedidoUnificadoAuditoria).where(inArray(pedidoUnificadoAuditoria.pedidoId, pedidos))
    await tx.delete(itemPedidoUnificado).where(inArray(itemPedidoUnificado.pedidoId, pedidos))
    await tx
      .delete(pedidoUnificado)
      .where(and(eq(pedidoUnificado.restauranteId, restauranteId), inArray(pedidoUnificado.id, pedidos)))
  }

  // Enlaces de recompra o de campaña que se armaron para esos clientes o esas campañas.
  const enlaceIds: number[] = []
  if (clientes.length > 0) {
    const filas = await tx
      .select({ id: marketingEnlace.id })
      .from(marketingEnlace)
      .where(and(eq(marketingEnlace.restauranteId, restauranteId), inArray(marketingEnlace.clienteId, clientes)))
    enlaceIds.push(...filas.map((f) => f.id))
  }
  if (campanas.length > 0) {
    const filas = await tx
      .select({ id: marketingEnlace.id })
      .from(marketingEnlace)
      .where(and(eq(marketingEnlace.restauranteId, restauranteId), inArray(marketingEnlace.campanaId, campanas)))
    enlaceIds.push(...filas.map((f) => f.id))
  }
  const enlaces = unicos(enlaceIds)
  if (enlaces.length > 0) {
    await tx
      .delete(marketingContacto)
      .where(and(eq(marketingContacto.restauranteId, restauranteId), inArray(marketingContacto.enlaceId, enlaces)))
    await tx
      .delete(marketingEnlace)
      .where(and(eq(marketingEnlace.restauranteId, restauranteId), inArray(marketingEnlace.id, enlaces)))
  }

  if (clientes.length > 0) {
    await tx
      .delete(marketingContacto)
      .where(and(eq(marketingContacto.restauranteId, restauranteId), inArray(marketingContacto.clienteId, clientes)))
    await tx
      .delete(colaRecompra)
      .where(and(eq(colaRecompra.restauranteId, restauranteId), inArray(colaRecompra.clienteId, clientes)))
    await tx
      .delete(campanaRecompraCliente)
      .where(
        and(
          eq(campanaRecompraCliente.restauranteId, restauranteId),
          inArray(campanaRecompraCliente.clienteId, clientes),
        ),
      )
    await tx
      .delete(recuperoCliente)
      .where(and(eq(recuperoCliente.restauranteId, restauranteId), inArray(recuperoCliente.clienteId, clientes)))
    await tx
      .delete(transaccionPuntos)
      .where(and(eq(transaccionPuntos.restauranteId, restauranteId), inArray(transaccionPuntos.clienteId, clientes)))
    await tx.delete(cliente).where(and(eq(cliente.restauranteId, restauranteId), inArray(cliente.id, clientes)))
  }

  if (campanas.length > 0) {
    await tx
      .delete(pedidoMarketingAtribucion)
      .where(
        and(eq(pedidoMarketingAtribucion.restauranteId, restauranteId), inArray(pedidoMarketingAtribucion.campanaId, campanas)),
      )
    const sesiones = await tx
      .select({ id: marketingSesion.id })
      .from(marketingSesion)
      .where(
        and(
          eq(marketingSesion.restauranteId, restauranteId),
          or(
            inArray(marketingSesion.firstTouchCampanaId, campanas),
            inArray(marketingSesion.lastTouchCampanaId, campanas),
          ),
        ),
      )
    const idsSesiones = sesiones.map((s) => s.id)
    await tx
      .delete(marketingEvento)
      .where(and(eq(marketingEvento.restauranteId, restauranteId), inArray(marketingEvento.campanaId, campanas)))
    for (const bloque of enBloques(idsSesiones, 500)) {
      await tx
        .delete(marketingEvento)
        .where(and(eq(marketingEvento.restauranteId, restauranteId), inArray(marketingEvento.marketingSesionId, bloque)))
      await tx
        .delete(marketingSesion)
        .where(and(eq(marketingSesion.restauranteId, restauranteId), inArray(marketingSesion.id, bloque)))
    }
    // Un pedido real que quedó atribuido a la campaña la pierde de referencia; el pedido sigue.
    await tx
      .update(pedidoUnificado)
      .set({ marketingCampanaId: null })
      .where(
        and(eq(pedidoUnificado.restauranteId, restauranteId), inArray(pedidoUnificado.marketingCampanaId, campanas)),
      )
    await tx
      .delete(marketingCampana)
      .where(and(eq(marketingCampana.restauranteId, restauranteId), inArray(marketingCampana.id, campanas)))
  }

  if (cupones.length > 0) {
    await tx
      .update(marketingCampana)
      .set({ codigoDescuentoId: null })
      .where(and(eq(marketingCampana.restauranteId, restauranteId), inArray(marketingCampana.codigoDescuentoId, cupones)))
    await tx
      .update(marketingEnlace)
      .set({ codigoDescuentoId: null })
      .where(and(eq(marketingEnlace.restauranteId, restauranteId), inArray(marketingEnlace.codigoDescuentoId, cupones)))
    await tx
      .update(pedidoUnificado)
      .set({ codigoDescuentoId: null })
      .where(and(eq(pedidoUnificado.restauranteId, restauranteId), inArray(pedidoUnificado.codigoDescuentoId, cupones)))
    await tx
      .delete(codigoDescuento)
      .where(and(eq(codigoDescuento.restauranteId, restauranteId), inArray(codigoDescuento.id, cupones)))
  }
}

/** Activa (gratis) los módulos incluidos que las campañas y los cupones de ejemplo necesitan. */
async function activarModulosIncluidos(tx: Db, restauranteId: number, ahora: Date) {
  const modulos = await tx
    .select({ id: modulo.id, tipo: modulo.tipo, activable: modulo.activable })
    .from(modulo)
    .where(and(inArray(modulo.codigo, MODULOS_INCLUIDOS_DEL_EJEMPLO), eq(modulo.activo, true)))
  for (const m of modulos) {
    if (m.tipo !== 'incluido' || !m.activable) continue
    const [actual] = await tx
      .select({ estado: restauranteModulo.estado })
      .from(restauranteModulo)
      .where(and(eq(restauranteModulo.restauranteId, restauranteId), eq(restauranteModulo.moduloId, m.id)))
      .limit(1)
    if (actual?.estado === 'activo') continue
    if (actual) {
      await tx
        .update(restauranteModulo)
        .set({ estado: 'activo', activadoAt: ahora, desactivadoAt: null, vigenteHasta: null, cancelarAlFinPeriodo: false })
        .where(and(eq(restauranteModulo.restauranteId, restauranteId), eq(restauranteModulo.moduloId, m.id)))
    } else {
      await tx.insert(restauranteModulo).values({
        restauranteId,
        moduloId: m.id,
        estado: 'activo',
        activadoAt: ahora,
        origen: 'interno',
      })
    }
  }
}

/**
 * Deja los datos de ejemplo del día. Idempotente y segura de llamar en cada entrada a la demo:
 * si ya están de hoy, o el dueño los borró, o la tienda ya tiene dueño, no hace nada.
 */
export async function sembrarDatosEjemplo(
  db: Db,
  restauranteId: number,
  opciones: { ahora?: Date; forzar?: boolean } = {},
): Promise<ResultadoSiembra> {
  const ahora = opciones.ahora ?? new Date()
  const forzar = opciones.forzar === true

  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db
    const [local] = await tx
      .select({
        origen: restaurante.origen,
        claimedAt: restaurante.claimedAt,
        telefonoVerificado: restaurante.telefonoVerificado,
        deliveryFee: restaurante.deliveryFee,
        direccionLat: restaurante.direccionLat,
        direccionLng: restaurante.direccionLng,
      })
      .from(restaurante)
      .where(eq(restaurante.id, restauranteId))
      .limit(1)
      .for('update')
    if (!local || !esProspectoSinReclamar(local)) return { estado: 'no_aplica' as const }

    const [previo] = await tx
      .select()
      .from(datosEjemplo)
      .where(eq(datosEjemplo.restauranteId, restauranteId))
      .limit(1)
    if (previo?.borradoAt && !forzar) return { estado: 'borrado' as const }
    if (previo && !previo.borradoAt && !forzar && previo.sembradoAt.getTime() >= inicioDiaAR(ahora.getTime())) {
      return { estado: 'vigente' as const }
    }
    // Los de otro día se rehacen: se borra lo viejo antes de sembrar lo nuevo.
    if (previo?.registros) await borrarRegistros(tx, restauranteId, previo.registros)

    if (!previo) {
      const [{ clientes: existentes }] = await tx
        .select({ clientes: count() })
        .from(cliente)
        .where(eq(cliente.restauranteId, restauranteId))
      const [{ pedidos: pedidosExistentes }] = await tx
        .select({ pedidos: count() })
        .from(pedidoUnificado)
        .where(eq(pedidoUnificado.restauranteId, restauranteId))
      // Una prueba de la tienda deja a lo sumo un cliente y un pedido; más que eso ya es un local operando.
      if (existentes > 2 || pedidosExistentes > 3) return { estado: 'con_datos_propios' as const }
    }

    const productos = await cargarProductos(tx, restauranteId)
    if (productos.length === 0) return { estado: 'sin_productos' as const }

    const sedes = await tx
      .select({ id: sucursal.id, lat: sucursal.direccionLat, lng: sucursal.direccionLng })
      .from(sucursal)
      .where(and(eq(sucursal.restauranteId, restauranteId), eq(sucursal.activo, true), eq(sucursal.soloPos, false)))
      .orderBy(asc(sucursal.id))
    const conUbicacion = [{ lat: local.direccionLat, lng: local.direccionLng }, ...sedes]
      .map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }))
      .find((u) => Number.isFinite(u.lat) && Number.isFinite(u.lng) && (u.lat !== 0 || u.lng !== 0))

    const plan = planificarDatosEjemplo({
      ahora,
      productos,
      envio: Number(local.deliveryFee) || 0,
      ubicacion: conUbicacion ?? null,
      semilla: restauranteId,
    })

    const idCliente = new Map<string, number>()
    for (const c of plan.clientes) {
      const [r] = await tx.insert(cliente).values({
        restauranteId,
        nombre: c.nombre,
        telefono: c.telefono,
        telefonoNormalizado: c.telefonoNormalizado,
        direccion: c.direccion,
        puntos: c.puntos,
        createdAt: c.creadoAt,
      })
      idCliente.set(c.clave, Number(r.insertId))
    }

    const [cuponInsertado] = await tx.insert(codigoDescuento).values({
      restauranteId,
      codigo: plan.cupon.codigo,
      tipo: 'porcentaje',
      valor: dos(plan.cupon.porcentaje),
      limiteUsos: plan.cupon.limiteUsos,
      usosActuales: plan.cupon.usos,
      montoMinimo: dos(0),
      activo: true,
      generadoAutomaticamente: false,
      createdAt: plan.campanas[0]?.activadaAt ?? ahora,
    })
    const idCupon = Number(cuponInsertado.insertId)

    const idCampana = new Map<string, number>()
    for (const c of plan.campanas) {
      const [r] = await tx.insert(marketingCampana).values({
        restauranteId,
        nombre: c.nombre,
        slug: c.slug,
        tipo: 'adquisicion',
        categoria: c.categoria,
        estado: 'activa',
        destinoTipo: 'tienda',
        codigoDescuentoId: c.conCupon ? idCupon : null,
        usosActuales: c.usos,
        fechaInicio: c.activadaAt,
        visitas: c.visitas,
        inversionManual: dos(c.inversionManual),
        activadaAt: c.activadaAt,
        createdAt: c.activadaAt,
        updatedAt: c.activadaAt,
      })
      idCampana.set(c.clave, Number(r.insertId))
    }

    const idsPedidos: number[] = []
    const itemsPendientes: (typeof itemPedidoUnificado.$inferInsert)[] = []
    for (const p of plan.pedidos) {
      const clienteId = idCliente.get(p.clienteClave)!
      // Cada cliente atiende en una sede (si el local tiene varias): así se ven en cualquiera de ellas.
      const indiceCliente = Number(p.clienteClave.slice(1)) - 1
      const sedeId = sedes.length > 0 ? sedes[indiceCliente % sedes.length].id : null
      const [r] = await tx.insert(pedidoUnificado).values({
        restauranteId,
        // La marca que los contadores de actividad real descartan (`pedidoReal`, pedido-ejemplo.ts).
        clientRequestId: nuevoRequestIdEjemplo(),
        sucursalId: sedeId,
        clienteId,
        marketingCampanaId: p.campanaClave ? idCampana.get(p.campanaClave)! : null,
        tipo: p.tipo,
        estado: p.estado,
        nombreCliente: p.nombreCliente,
        telefono: p.telefono,
        notas: p.nota,
        total: dos(p.total),
        pagado: p.pagado,
        metodoPago: p.metodoPago,
        direccion: p.direccion,
        latitud: p.latitud,
        longitud: p.longitud,
        codigoDescuentoId: p.usaCupon ? idCupon : null,
        montoDescuento: dos(p.descuento),
        puntosGanados: p.puntosGanados,
        deliveryFee: p.tipo === 'delivery' ? dos(p.envio) : null,
        // Ya impresos: abrir el panel de la demo con una impresora conectada no saca comandas.
        impreso: true,
        createdAt: p.creadoAt,
        updatedAt: p.creadoAt,
        deliveredAt: p.estado === 'archived' ? new Date(p.creadoAt.getTime() + 45 * 60_000) : null,
      })
      const pedidoId = Number(r.insertId)
      idsPedidos.push(pedidoId)
      for (const it of p.items) {
        itemsPendientes.push({
          pedidoId,
          productoId: it.productoId,
          varianteId: it.varianteId,
          varianteNombre: it.varianteNombre,
          varianteSecundariaId: it.varianteSecundariaId,
          varianteSecundariaNombre: it.varianteSecundariaNombre,
          cantidad: it.cantidad,
          cantidadImpresa: it.cantidad,
          precioUnitario: dos(it.precioUnitario),
          esCanjePuntos: false,
          ingredientesExcluidos: [],
          agregados: [],
          clienteNombre: p.nombreCliente,
          clienteTelefono: p.telefono,
          clienteId,
        })
      }
    }
    for (const bloque of enBloques(itemsPendientes)) await tx.insert(itemPedidoUnificado).values(bloque)

    const registros: RegistrosEjemplo = {
      clientes: [...idCliente.values()],
      pedidos: idsPedidos,
      campanas: [...idCampana.values()],
      cupones: [idCupon],
    }
    await tx
      .insert(datosEjemplo)
      .values({ restauranteId, sembradoAt: ahora, borradoAt: null, registros })
      .onDuplicateKeyUpdate({ set: { sembradoAt: ahora, borradoAt: null, registros } })

    // Lo que sigue es para que se vea mejor, no para que funcione: si falla, el resto queda sembrado.
    try {
      const sesiones = plan.sesiones.map((s) => ({
        restauranteId,
        sesionUuid: randomUUID(),
        visitorId: randomUUID(),
        firstTouchTipo: 'campana' as const,
        firstTouchCampanaId: idCampana.get(s.campanaClave)!,
        firstTouchAt: s.creadoAt,
        lastTouchTipo: 'campana' as const,
        lastTouchCampanaId: idCampana.get(s.campanaClave)!,
        lastTouchAt: s.creadoAt,
        expiraAt: new Date(s.creadoAt.getTime() + 30 * 60_000),
        createdAt: s.creadoAt,
        updatedAt: s.creadoAt,
      }))
      for (const bloque of enBloques(sesiones)) await tx.insert(marketingSesion).values(bloque)
    } catch (error) {
      console.warn('[datos-ejemplo] No se pudieron sembrar las visitas de las campañas:', (error as Error).message)
    }
    try {
      await activarModulosIncluidos(tx, restauranteId, ahora)
    } catch (error) {
      console.warn('[datos-ejemplo] No se pudieron activar los módulos incluidos:', (error as Error).message)
    }

    return {
      estado: 'sembrado' as const,
      clientes: plan.clientes.length,
      pedidos: plan.pedidos.length,
      campanas: plan.campanas.length,
    }
  })
}

/** Borra todo lo de ejemplo del local y deja constancia para que no se vuelva a sembrar solo. */
export async function borrarDatosEjemplo(
  db: Db,
  restauranteId: number,
  ahora = new Date(),
): Promise<{ borrados: boolean }> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db
    // Mismo bloqueo que la siembra: borrar y sembrar no corren a la vez.
    await tx.select({ id: restaurante.id }).from(restaurante).where(eq(restaurante.id, restauranteId)).limit(1).for('update')
    const [fila] = await tx.select().from(datosEjemplo).where(eq(datosEjemplo.restauranteId, restauranteId)).limit(1)
    if (!fila) return { borrados: false }
    await borrarRegistros(tx, restauranteId, fila.registros)
    await tx
      .update(datosEjemplo)
      .set({ borradoAt: ahora, registros: { clientes: [], pedidos: [], campanas: [], cupones: [] } })
      .where(eq(datosEjemplo.restauranteId, restauranteId))
    return { borrados: true }
  })
}

export interface EstadoDatosEjemplo {
  /** Quedan datos de ejemplo en el local. */
  hay: boolean
  /** El dueño los borró (no se vuelven a sembrar solos). */
  borrado: boolean
  clientes: number
  pedidos: number
  campanas: number
}

/** Lo que queda de lo sembrado: la cuenta sale de las filas que existen, no de los ids guardados. */
export async function estadoDatosEjemplo(db: Db, restauranteId: number): Promise<EstadoDatosEjemplo> {
  const [fila] = await db.select().from(datosEjemplo).where(eq(datosEjemplo.restauranteId, restauranteId)).limit(1)
  if (!fila) return { hay: false, borrado: false, clientes: 0, pedidos: 0, campanas: 0 }
  const registros = fila.registros
  const clientesIds = registros.clientes ?? []
  const pedidosIds = registros.pedidos ?? []
  const campanasIds = registros.campanas ?? []
  const [clientes, pedidos, campanas] = await Promise.all([
    clientesIds.length === 0
      ? 0
      : db
          .select({ n: count() })
          .from(cliente)
          .where(and(eq(cliente.restauranteId, restauranteId), inArray(cliente.id, clientesIds)))
          .then(([r]) => Number(r?.n ?? 0)),
    pedidosIds.length === 0
      ? 0
      : db
          .select({ n: count() })
          .from(pedidoUnificado)
          .where(and(eq(pedidoUnificado.restauranteId, restauranteId), inArray(pedidoUnificado.id, pedidosIds)))
          .then(([r]) => Number(r?.n ?? 0)),
    campanasIds.length === 0
      ? 0
      : db
          .select({ n: count() })
          .from(marketingCampana)
          .where(and(eq(marketingCampana.restauranteId, restauranteId), inArray(marketingCampana.id, campanasIds)))
          .then(([r]) => Number(r?.n ?? 0)),
  ])
  return {
    hay: clientes + pedidos + campanas > 0,
    borrado: fila.borradoAt != null,
    clientes,
    pedidos,
    campanas,
  }
}

/**
 * Para la entrada a la demo: deja los datos del día sin que un fallo impida entrar al panel (con
 * o sin ellos se puede explorar). Devuelve el resultado o `null` si falló.
 */
export async function asegurarDatosEjemplo(db: Db, restauranteId: number): Promise<ResultadoSiembra | null> {
  try {
    return await sembrarDatosEjemplo(db, restauranteId)
  } catch (error) {
    console.error(`[datos-ejemplo] No se pudieron sembrar los datos del local ${restauranteId}:`, (error as Error).message)
    return null
  }
}
