import { describe, expect, test } from 'bun:test'
import { getTableName } from 'drizzle-orm'
import {
  crearDateArgentina,
  obtenerComponentesArgentina,
} from './motor-recompra-patron'
import {
  guardarConfigMotor,
  marcarFilaColaComoEnviadaManual,
  obtenerMensajeFilaCola,
  programarEnvios,
  vencerInvitacionesPasadas,
} from './motor-recompra'
import { descifrarGrowthPayload } from './marketing-crypto'

// Repositorio Drizzle de prueba: no abre conexiones ni escribe datos reales. Conserva los
// inserts para verificar lo que programarEnvios realmente agenda, además de la cuenta pura.
function repositorio(
  opciones: {
    modo?: 'manual' | 'automatico'
    conectado?: boolean
    diasAbiertos?: number[]
    fila?: Record<string, any>
    tanda?: Record<string, any>
    cupoDiario?: number
    clientes?: number
    cupon?: Record<string, any>
    toques?: Date[]
  } = {},
) {
  const ahora = Date.now()
  const inserts: { tabla: string; valores: any }[] = []
  const updates: { tabla: string; valores: any }[] = []
  const ids = Array.from({ length: opciones.clientes ?? 4 }, (_, i) => i + 1)
  const filas: Record<string, any[]> = {
    restaurante: [
      {
        enabled: opciones.conectado ?? false,
        token: opciones.conectado ? 'token-de-prueba' : null,
        nombre: 'Brasa',
        username: 'brasa',
      },
    ],
    cola_recompra: opciones.fila ? [opciones.fila] : [],
    campana_recompra: opciones.tanda ? [opciones.tanda] : [],
    config_motor_recompra: opciones.modo || opciones.cupoDiario
      ? [
          {
            id: 1,
            restauranteId: 7,
            modo: opciones.modo ?? 'manual',
            estado: 'activa',
            cupoDiario: opciones.cupoDiario ?? 30,
            diasToque2: 2,
            diasToque3: 2,
            porcentajeControl: 30,
          },
        ]
      : [],
    horario_restaurante: (opciones.diasAbiertos ?? []).map((dia) => ({ dia })),
    pedido_unificado: ids.map((clienteId) => ({
      id: clienteId,
      clienteId,
      createdAt: new Date(ahora - (20 + clienteId) * 86400000),
      total: '1000',
      pagado: true,
      estado: 'delivered',
    })),
    cliente: ids.map((id) => ({
      id,
      nombre: `Cliente ${id}`,
      telefono: '5491155551234',
      marketingOptOut: id === 4,
    })),
    modulo: [
      {
        id: 1,
        codigo: 'motor_recompra',
        nombre: 'Retención',
        tipo: 'incluido',
        precioMensual: '0',
        activoCatalogo: true,
        estado: 'activo',
        origen: 'manual',
        vigenteHasta: null,
        mensajesUtilityIncluidos: 0,
        mensajesMarketingIncluidos: 0,
      },
    ],
    suscripcion: [{ estado: 'activa' }],
    codigo_descuento: opciones.cupon ? [opciones.cupon] : [],
    recupero_cliente: (opciones.toques ?? []).map((createdAt) => ({
      clienteId: 1,
      nivel: 1,
      createdAt,
    })),
  }
  const db = {
    select: () => {
      let tabla = ''
      const consulta: any = {
        from: (t: any) => {
          tabla = getTableName(t)
          return consulta
        },
        where: () => consulta,
        limit: () => consulta,
        innerJoin: () => consulta,
        leftJoin: () => consulta,
        orderBy: () => consulta,
        for: () => consulta,
        then: (resolve: any, reject: any) =>
          Promise.resolve(filas[tabla] ?? []).then(resolve, reject),
      }
      return consulta
    },
    insert: (tabla: any) => ({
      values: async (valores: any) => {
        inserts.push({ tabla: getTableName(tabla), valores })
        return [{ insertId: 19 }]
      },
    }),
    update: (tabla: any) => ({
      set: (valores: any) => ({
        where: async () => {
          updates.push({ tabla: getTableName(tabla), valores })
          return [{ affectedRows: 1 }]
        },
      }),
    }),
    transaction: async (trabajo: (tx: any) => Promise<any>) => trabajo(db),
  }
  return { db: db as any, inserts, updates }
}
function manana() {
  const d = obtenerComponentesArgentina(Date.now() + 86400000)
  return `${d.anio}-${String(d.mes + 1).padStart(2, '0')}-${String(d.diaMes).padStart(2, '0')}`
}
/** Hoy a las 15 de Argentina: fuera del silencio de 22 a 9, para que la prueba no dependa de la hora. */
function hoyALas15() {
  const d = obtenerComponentesArgentina(Date.now())
  return crearDateArgentina(d.anio, d.mes, d.diaMes, 15).getTime()
}
const filaDeTanda = (dueDate: Date) => ({
  id: 1,
  campanaId: 19,
  clienteId: 1,
  segmento: 'dormido',
  toque: 1,
  estado: 'pendiente',
  rol: 'contactado',
  dueDate,
  ultimoPedidoAtSnapshot: new Date(Date.now() - 10 * 86400000),
  horarioSugerido: 'Martes 19:00 hs',
})
const tandaConTextoLibre = {
  id: 19,
  mensajePersonalizado: 'Hola {nombre}, vení a {local}. {beneficio} {link}',
  descuentoPorcentaje: 15,
}
describe('tandas de marketer: escritura real del planificador con repositorio de prueba', () => {
  test('un mensaje que todavía no puede salir se ve, pero sin link para abrir WhatsApp ni cupón armado', async () => {
    const ahora = hoyALas15()
    const { db, inserts } = repositorio({
      fila: filaDeTanda(new Date(ahora + 4 * 3600000)),
      tanda: tandaConTextoLibre,
    })
    const resultado = await obtenerMensajeFilaCola(db, 7, 1, {}, ahora)
    expect(resultado.ok).toBe(true)
    if (!resultado.ok) return
    expect(resultado.data.texto).toContain('Hola Cliente 1, vení a Brasa.')
    expect(resultado.data.descuento).toBe(15)
    expect(resultado.data.envio).toMatchObject({ puedeEnviar: false })
    expect(resultado.data.envio.motivo).toContain('programado')
    expect(resultado.data.waMeUrl).toBeNull()
    const token = new URL(resultado.data.urlTienda).searchParams.get('tk')!
    expect(descifrarGrowthPayload(token)).toMatchObject({
      origen: 'recompra',
      dto: 15,
      rId: 7,
      cId: 1,
    })
    expect(inserts).toHaveLength(0)
  })
  test('un mensaje listo para salir deja armado el cupón que su link promete, antes de marcarlo', async () => {
    const ahora = hoyALas15()
    const { db, inserts } = repositorio({
      fila: filaDeTanda(new Date(ahora - 3600000)),
      tanda: tandaConTextoLibre,
    })
    const resultado = await obtenerMensajeFilaCola(db, 7, 1, {}, ahora)
    expect(resultado.ok).toBe(true)
    if (!resultado.ok) return
    expect(resultado.data.envio).toEqual({ puedeEnviar: true, motivo: null })
    expect(resultado.data.waMeUrl).toStartWith(
      'https://api.whatsapp.com/send?phone=',
    )
    expect(resultado.data.codigoDescuento).toBe('VOLVE15-1')
    expect(inserts).toEqual([
      expect.objectContaining({
        tabla: 'codigo_descuento',
        valores: expect.objectContaining({ codigo: 'VOLVE15-1', usosActuales: 0 }),
      }),
    ])
  })
  test('el cupón que ya armó este mismo mensaje no se revive si el cliente lo usó', async () => {
    const ahora = hoyALas15()
    const { db, inserts, updates } = repositorio({
      fila: filaDeTanda(new Date(ahora - 3600000)),
      tanda: tandaConTextoLibre,
      toques: [new Date(ahora - 5 * 86400000)],
      cupon: { id: 40, fechaInicio: new Date(ahora - 1800000), usosActuales: 1 },
    })
    const resultado = await obtenerMensajeFilaCola(db, 7, 1, {}, ahora)
    expect(resultado.ok && resultado.data.envio.puedeEnviar).toBe(true)
    expect(inserts).toHaveLength(0)
    expect(updates).toHaveLength(1)
    expect(Object.keys(updates[0].valores)).toEqual(['fechaFin'])
  })
  test('el cupón de un mensaje anterior se rearma para el nuevo', async () => {
    const ahora = hoyALas15()
    const { db, updates } = repositorio({
      fila: filaDeTanda(new Date(ahora - 3600000)),
      tanda: tandaConTextoLibre,
      toques: [new Date(ahora - 5 * 86400000)],
      cupon: { id: 40, fechaInicio: new Date(ahora - 6 * 86400000), usosActuales: 1 },
    })
    await obtenerMensajeFilaCola(db, 7, 1, {}, ahora)
    expect(updates).toEqual([
      expect.objectContaining({
        tabla: 'codigo_descuento',
        valores: expect.objectContaining({ usosActuales: 0, activo: true }),
      }),
    ])
  })
  test('una invitación de día flojo que no salió en su día ya no ofrece WhatsApp ni arma cupón', async () => {
    const ahora = hoyALas15()
    const { db, inserts } = repositorio({
      fila: { ...filaDeTanda(new Date(ahora - 20 * 3600000)), tipoMensaje: 'dia_flojo' },
      tanda: { ...tandaConTextoLibre, origen: 'dia_flojo' },
    })
    const resultado = await obtenerMensajeFilaCola(db, 7, 1, {}, ahora)
    expect(resultado.ok).toBe(true)
    if (!resultado.ok) return
    expect(resultado.data.envio).toMatchObject({ puedeEnviar: false })
    expect(resultado.data.envio.motivo).toContain('ya pasó su día')
    expect(resultado.data.waMeUrl).toBeNull()
    expect(inserts).toHaveLength(0)
  })
  test('el tick cierra las invitaciones vencidas como salidas, sin contarlas como enviadas', async () => {
    const vencida = repositorio({
      fila: filaDeTanda(new Date(Date.now() - 2 * 86400000)),
      tanda: { ...tandaConTextoLibre, origen: 'dia_flojo' },
    })
    expect(await vencerInvitacionesPasadas(vencida.db, 7)).toBe(1)
    expect(vencida.updates[0]).toEqual({
      tabla: 'cola_recompra',
      valores: { estado: 'salido', errorEnvio: 'invitacion_vencida' },
    })
    const sinFilas = repositorio()
    expect(await vencerInvitacionesPasadas(sinFilas.db, 7)).toBe(0)
    expect(sinFilas.updates).toHaveLength(0)
  })
  test('registro manual no admite un envío futuro ni modifica el ledger en un reintento ya enviado', async () => {
    const futuro = repositorio({
      fila: {
        id: 1,
        campanaId: 19,
        clienteId: 1,
        estado: 'pendiente',
        rol: 'contactado',
        dueDate: new Date(Date.now() + 86400000),
      },
    })
    expect(
      await marcarFilaColaComoEnviadaManual(futuro.db, 7, 1),
    ).toMatchObject({ ok: false })
    expect(futuro.inserts).toHaveLength(0)
    const anterior = repositorio({
      fila: { id: 1, campanaId: 19, clienteId: 1, estado: 'enviado' },
    })
    expect(
      await marcarFilaColaComoEnviadaManual(anterior.db, 7, 1),
    ).toMatchObject({ ok: true, mensaje: 'Ya estaba marcado como enviado' })
    expect(anterior.inserts).toHaveLength(0)
  })
  test('fecha agenda todos a la misma hora, conserva control y texto, fuerza un mensaje y guarda autor', async () => {
    const { db, inserts } = repositorio()
    const resultado = await programarEnvios(db, 7, {
      cantidad: 20,
      porcentajeControl: 30,
      fechaObjetivo: manana(),
      horaObjetivo: 19,
      toqueHasta: 3,
      mensaje: 'Volvé, {nombre}: {link}',
      descuentoPorcentaje: 10,
      marketerId: 8,
      incluirIds: [1, 2, 4],
      soloIncluidos: true,
    })
    expect(resultado.ok).toBe(true)
    expect(resultado.cantidad).toBe(2)
    expect(resultado.control).toBe(1)
    const campana = inserts.find((i) => i.tabla === 'campana_recompra')?.valores
    expect(campana).toMatchObject({
      restauranteId: 7,
      origen: 'dia_flojo',
      toqueHasta: 1,
      marketerId: 8,
      mensajePersonalizado: 'Volvé, {nombre}: {link}',
      descuentoPorcentaje: 10,
    })
    const cola = inserts
      .filter((i) => i.tabla === 'cola_recompra')
      .map((i) => i.valores)
    expect(cola.some((f) => f.clienteId === 4)).toBe(false)
    expect(cola.filter((f) => f.rol === 'control')).toHaveLength(1)
    const enviados = cola.filter((f) => f.rol === 'contactado')
    expect(enviados).toHaveLength(2)
    const [anio, mes, dia] = manana().split('-').map(Number)
    expect(
      enviados.every(
        (f) =>
          f.dueDate.getTime() ===
          crearDateArgentina(anio, mes - 1, dia, 19).getTime(),
      ),
    ).toBe(true)
    expect(enviados.every((f) => f.horarioSugerido.includes('día flojo'))).toBe(
      true,
    )
  })
  test('una invitación de día flojo no puede pedir más mensajes que el cupo diario', async () => {
    const { db, inserts } = repositorio({ cupoDiario: 5, clientes: 8 })
    await expect(
      programarEnvios(db, 7, {
        cantidad: 6,
        fechaObjetivo: manana(),
        horaObjetivo: 19,
        incluirIds: [1, 2, 3, 5, 6, 7],
        soloIncluidos: true,
      }),
    ).rejects.toThrow('cupo diario')
    expect(inserts).toHaveLength(0)
    const enCupo = repositorio({ cupoDiario: 5, clientes: 8 })
    const resultado = await programarEnvios(enCupo.db, 7, {
      cantidad: 5,
      fechaObjetivo: manana(),
      horaObjetivo: 19,
      incluirIds: [1, 2, 3, 5, 6],
      soloIncluidos: true,
    })
    expect(resultado).toMatchObject({ ok: true, cantidad: 5 })
  })
  test('rechaza texto libre automático antes de insertar', async () => {
    const { db, inserts } = repositorio({ modo: 'automatico', conectado: true })
    await expect(
      programarEnvios(db, 7, { cantidad: 1, mensaje: 'Hola libre' }),
    ).rejects.toThrow('manual')
    expect(inserts).toHaveLength(0)
  })
  test('rechaza fecha cerrada y mensaje excesivo sin escribir', async () => {
    const { db, inserts } = repositorio({
      diasAbiertos: [obtenerComponentesArgentina(Date.now()).diaSemana],
    })
    await expect(
      programarEnvios(db, 7, { fechaObjetivo: manana(), cantidad: 1 }),
    ).rejects.toThrow('cerrado')
    await expect(
      programarEnvios(db, 7, { mensaje: 'a'.repeat(701), cantidad: 1 }),
    ).rejects.toThrow('700')
    expect(inserts).toHaveLength(0)
  })
  test('no permite activar automático sin el WhatsApp del local', async () => {
    const { db, inserts } = repositorio()
    await expect(
      guardarConfigMotor(db, 7, { modo: 'automatico' }),
    ).rejects.toThrow('WhatsApp')
    expect(inserts).toHaveLength(0)
  })
})
