import {
  colaRecompra,
  configuracionSuscripcion,
  horarioRestaurante,
  pedidoUnificado,
  restaurante,
  restauranteModulo,
  sucursal,
  suscripcion,
} from '../db/schema'

/** Filas que devuelve cada tabla; los filtros SQL se ignoran, así que van ya filtradas. */
export interface DatosLocalFalsos {
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
export const AHORA_LOCAL = new Date('2026-10-03T20:00:00Z')
const DIA = 86400000
const hace = (dias: number) => new Date(AHORA_LOCAL.getTime() - dias * DIA)

/**
 * Brasa (6) con un mes de pedidos salvo los martes, Retención y Campañas. Las filas de Pizza (7)
 * prueban que la tarjeta sólo cuenta las del local pedido.
 */
export function datosLocalEjemplo(): DatosLocalFalsos {
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
        tipo: 'incluido',
        precio: '0.00',
        estado: 'activo',
        origen: 'migracion',
        precioMensualCongelado: null,
        vigenteHasta: null,
        catalogoActivo: true,
      },
      {
        restauranteId: 6,
        codigo: 'dias_flojos',
        tipo: 'incluido',
        precio: '0.00',
        estado: 'activo',
        origen: 'migracion',
        precioMensualCongelado: null,
        vigenteHasta: null,
        catalogoActivo: true,
      },
      {
        restauranteId: 6,
        codigo: 'puntos_clientes',
        tipo: 'incluido',
        precio: '0.00',
        estado: 'activo',
        origen: 'migracion',
        precioMensualCongelado: null,
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

/** La tarjeta de Brasa que devuelve `GET /marketing-local`. */
export const TARJETA_BRASA = {
  restauranteId: 6,
  nombre: 'Brasa',
  username: 'brasa',
  imagenUrl: null,
  colorPrimario: '#ff7a00',
  baseTienda: 'https://my.piru.app/brasa',
  whatsappConectado: true,
  recompraActiva: true,
  diasFlojosActivo: true,
  puntosActivo: true,
  crecimientoActivo: true,
  codigosDescuentoActivo: false,
  suscripcion: { estado: 'activa', montoMensual: 25000 },
  ventas30d: 24000,
  ventas30dAnterior: 7000,
  pedidos30d: 25,
  ventasSemanales: [0, 0, 7000, 2000, 6000, 6000, 6000, 4000],
  clientesNuevos30d: 1,
  diaMasFlojo: { diaSemana: 2, nombre: 'Martes' },
  mensajesParaHoy: 0,
}

/**
 * Doble de Drizzle para las consultas de la tarjeta del local: cada `select` resuelve por la tabla del
 * `from`. Los dos `select` sobre `pedido_unificado` se distinguen porque sólo los primeros
 * pedidos llevan `groupBy`.
 */
export function dbLocalFalsa(datos: DatosLocalFalsos) {
  const consultas: unknown[] = []
  /** La condición de cada `where` con la tabla de su `from`: sirve para probar qué se filtra. */
  const condiciones: { tabla: unknown; condicion: unknown }[] = []
  /** Las columnas pedidas en cada `select`, en orden: sirven para probar que no se lee de más. */
  const columnas: string[][] = []
  const filas = (tabla: unknown, agrupada: boolean) => {
    if (tabla === restaurante) return datos.restaurantes ?? []
    if (tabla === pedidoUnificado)
      return (agrupada ? datos.primeros : datos.pedidos) ?? []
    if (tabla === suscripcion) return datos.suscripciones ?? []
    if (tabla === restauranteModulo) return datos.modulos ?? []
    if (tabla === horarioRestaurante) return datos.horarios ?? []
    if (tabla === colaRecompra) return datos.mensajes ?? []
    if (tabla === configuracionSuscripcion) return datos.configuracion ?? []
    if (tabla === sucursal) return datos.sucursales ?? []
    throw new Error('Tabla sin datos en el doble del local')
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
        where: (condicion?: unknown) => {
          condiciones.push({ tabla, condicion })
          return query
        },
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
  return { db: db as any, consultas, columnas, condiciones }
}
