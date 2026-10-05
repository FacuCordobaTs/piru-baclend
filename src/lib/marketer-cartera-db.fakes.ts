import {
  colaRecompra,
  configuracionSuscripcion,
  horarioRestaurante,
  pedidoUnificado,
  restaurante,
  restauranteMarketer,
  restauranteModulo,
  sucursal,
  suscripcion,
} from '../db/schema'

/** Filas que devuelve cada tabla; los filtros SQL se ignoran, así que van ya filtradas. */
export interface DatosCarteraFalsa {
  vinculos?: object[]
  restaurantes?: object[]
  pedidos?: object[]
  primeros?: object[]
  suscripciones?: object[]
  modulos?: object[]
  horarios?: object[]
  mensajes?: object[]
  configuracion?: object[]
  sucursales?: object[]
}

/** Instante fijo de los ejemplos: sábado 3 de octubre de 2026, 17 hs de Argentina. */
export const AHORA_CARTERA = new Date('2026-10-03T20:00:00Z')
const DIA = 86400000
const hace = (dias: number) => new Date(AHORA_CARTERA.getTime() - dias * DIA)

/**
 * Brasa (6) con un mes de pedidos salvo los martes, Retención y Campañas; Pizza (7) en prueba,
 * con dominio propio, override de comisión y mensajes para hoy; y un local que revocó (8).
 */
export function datosCarteraEjemplo(): DatosCarteraFalsa {
  const pedidosBrasa = Array.from({ length: 28 }, (_, i) => hace(i + 1))
    // 15 UTC = mediodía de Argentina: el día de la semana es el mismo en las dos zonas.
    .map((d) => new Date(d.getTime() - 5 * 3600000))
    .filter((d) => d.getUTCDay() !== 2)
    .map((createdAt) => ({
      restauranteId: 6,
      createdAt,
      pagado: true,
      total: '1000.00',
      estado: 'delivered',
    }))
  return {
    vinculos: [
      {
        restauranteId: 6,
        nombre: 'Brasa',
        username: 'brasa',
        imagenUrl: null,
        colorPrimario: '#ff7a00',
        dominioTienda: null,
        whatsappConectado: 1,
        desde: new Date('2026-09-01T12:00:00Z'),
        estado: 'activo',
        revocadoAt: null,
        porcentaje: null,
      },
      {
        restauranteId: 7,
        nombre: null,
        username: null,
        imagenUrl: 'https://cdn.example/pizza.png',
        colorPrimario: null,
        dominioTienda: 'pizza.example',
        whatsappConectado: 0,
        desde: new Date('2026-09-10T12:00:00Z'),
        estado: 'activo',
        revocadoAt: null,
        porcentaje: '15.00',
      },
      {
        restauranteId: 8,
        nombre: 'Vieja',
        username: 'vieja',
        imagenUrl: null,
        colorPrimario: null,
        dominioTienda: null,
        whatsappConectado: 0,
        desde: new Date('2026-08-01T12:00:00Z'),
        estado: 'revocado',
        revocadoAt: new Date('2026-09-20T12:00:00Z'),
        porcentaje: null,
      },
    ],
    restaurantes: [
      {
        // `id` para el canje de la sesión; el resto, las columnas de la tarjeta.
        id: 6,
        restauranteId: 6,
        nombre: 'Brasa',
        username: 'brasa',
        imagenUrl: null,
        colorPrimario: '#ff7a00',
        dominioTienda: null,
        whatsappConectado: 1,
      },
    ],
    pedidos: [
      ...pedidosBrasa,
      {
        restauranteId: 6,
        createdAt: hace(1),
        pagado: false,
        total: '5000.00',
        estado: 'pending',
      },
      {
        restauranteId: 6,
        createdAt: hace(40),
        pagado: true,
        total: '7000.00',
        estado: 'delivered',
      },
      {
        restauranteId: 7,
        createdAt: hace(3),
        pagado: true,
        total: '2000.00',
        estado: 'delivered',
      },
    ],
    primeros: [
      { restauranteId: 6, clienteId: 1, primero: hace(5) },
      { restauranteId: 6, clienteId: 2, primero: hace(90) },
      { restauranteId: 7, clienteId: 3, primero: hace(3) },
    ],
    suscripciones: [
      {
        restauranteId: 6,
        estado: 'activa',
        montoMensual: '40000.00',
        precioBase: '30000.00',
        precioMensual: null,
      },
      {
        restauranteId: 7,
        estado: 'trial',
        montoMensual: null,
        precioBase: null,
        precioMensual: '20000.00',
      },
    ],
    modulos: [
      {
        restauranteId: 6,
        codigo: 'motor_recompra',
        tipo: 'pago',
        precio: '15000.00',
        estado: 'activo',
        origen: 'usuario',
        precioMensualCongelado: '12000.00',
        vigenteHasta: null,
        catalogoActivo: true,
      },
      {
        restauranteId: 6,
        codigo: 'crecimiento',
        tipo: 'incluido',
        precio: '0.00',
        estado: 'activo',
        origen: 'usuario',
        precioMensualCongelado: null,
        vigenteHasta: null,
        catalogoActivo: true,
      },
      {
        restauranteId: 7,
        codigo: 'motor_recompra',
        tipo: 'pago',
        precio: '15000.00',
        estado: 'activo',
        origen: 'usuario',
        precioMensualCongelado: null,
        vigenteHasta: null,
        catalogoActivo: true,
      },
      {
        restauranteId: 7,
        codigo: 'codigos_descuento',
        tipo: 'incluido',
        precio: '0.00',
        estado: 'activo',
        origen: 'usuario',
        precioMensualCongelado: null,
        vigenteHasta: null,
        catalogoActivo: true,
      },
    ],
    horarios: [],
    mensajes: [{ restauranteId: 7, cantidad: '3' }],
    configuracion: [{ precioMensual: '25000.00' }],
  }
}

/** La tarjeta de Brasa que devuelve la cartera; el dueño ve la misma, sin vínculo ni comisión. */
export const TARJETA_BRASA = {
  restauranteId: 6,
  nombre: 'Brasa',
  username: 'brasa',
  imagenUrl: null,
  colorPrimario: '#ff7a00',
  baseTienda: 'https://my.piru.app/brasa',
  desde: '2026-09-01T12:00:00.000Z',
  whatsappConectado: true,
  retencionActiva: true,
  crecimientoActivo: true,
  codigosDescuentoActivo: false,
  suscripcion: { estado: 'activa', montoMensual: 37000 },
  ventas30d: 24000,
  ventas30dAnterior: 7000,
  pedidos30d: 25,
  ventasSemanales: [0, 0, 7000, 2000, 6000, 6000, 6000, 4000],
  clientesNuevos30d: 1,
  diaMasFlojo: { diaSemana: 2, nombre: 'Martes' },
  mensajesParaHoy: 0,
  comisionEstimadaMensual: 7400,
}

/**
 * Doble de Drizzle para las consultas de la cartera: cada `select` resuelve por la tabla del
 * `from`. Los dos `select` sobre `pedido_unificado` se distinguen porque sólo los primeros
 * pedidos llevan `groupBy`.
 */
export function dbCarteraFalsa(datos: DatosCarteraFalsa) {
  const consultas: unknown[] = []
  /** Las columnas pedidas en cada `select`, en orden: sirven para probar que no se lee de más. */
  const columnas: string[][] = []
  const filas = (tabla: unknown, agrupada: boolean) => {
    if (tabla === restauranteMarketer) return datos.vinculos ?? []
    if (tabla === restaurante) return datos.restaurantes ?? []
    if (tabla === pedidoUnificado)
      return (agrupada ? datos.primeros : datos.pedidos) ?? []
    if (tabla === suscripcion) return datos.suscripciones ?? []
    if (tabla === restauranteModulo) return datos.modulos ?? []
    if (tabla === horarioRestaurante) return datos.horarios ?? []
    if (tabla === colaRecompra) return datos.mensajes ?? []
    if (tabla === configuracionSuscripcion) return datos.configuracion ?? []
    if (tabla === sucursal) return datos.sucursales ?? []
    throw new Error('Tabla sin datos en el doble de la cartera')
  }
  const db = {
    select: (campos?: Record<string, unknown>) => {
      columnas.push(Object.keys(campos ?? {}))
      let tabla: unknown
      let agrupada = false
      const query: any = {
        from: (t: unknown) => {
          tabla = t
          consultas.push(t)
          return query
        },
        innerJoin: () => query,
        where: () => query,
        limit: () => query,
        orderBy: () => query,
        groupBy: () => {
          agrupada = true
          return query
        },
        then: (
          ok: (v: unknown) => unknown,
          error: (e: unknown) => unknown,
        ) =>
          Promise.resolve()
            .then(() => filas(tabla, agrupada))
            .then(ok, error),
      }
      return query
    },
  }
  return { db: db as any, consultas, columnas }
}
