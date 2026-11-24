import { describe, expect, test } from 'bun:test'
import {
  esCapacidadPlan,
  esEsquemaPendiente,
  moduloActivoEnPlan,
  normalizarPlanCodigo,
  planEfectivo,
  planIncluyeModulo,
  planMinimoParaModulo,
  type PlanTiendaCatalogo,
} from './planes-tienda'
import { moduloActivoParaPlan, moduloEstaActivoAhora, type PoliticaModuloInput } from './modulos'
import { calcularPasos, resumenPasos, type DatosPasos } from './primeros-pasos'
import { crearTiendaSchema, valoresTiendaNueva } from './registro-tienda'
import { cambiaCodigo } from '../routes/sitios'

const plan = (codigo: PlanTiendaCatalogo['codigo'], orden: number, precio: number | null, modulos: string[]): PlanTiendaCatalogo => ({
  codigo, nombre: codigo, descripcion: null, precioMensual: precio, descuentoAnual: 20, orden, destacado: false, modulos, beneficios: [],
})

const CATALOGO: PlanTiendaCatalogo[] = [
  plan('inicial', 1, 0, ['mercadopago', 'impresion_comandas']),
  plan('esencial', 2, 19999, ['mercadopago', 'impresion_comandas', 'diseno_personalizado', 'pos']),
  plan('impulso', 3, 39999, ['mercadopago', 'impresion_comandas', 'diseno_personalizado', 'pos', 'codigo_fuente', 'avisos_automaticos_whatsapp']),
  plan('escala', 4, 79999, ['mercadopago', 'impresion_comandas', 'diseno_personalizado', 'pos', 'codigo_fuente', 'avisos_automaticos_whatsapp', 'estadisticas_avanzadas']),
  plan('evolucion', 5, null, []),
]

describe('plan efectivo', () => {
  test('Evolución nunca baja, tenga o no suscripción', () => {
    expect(planEfectivo({ contratado: 'evolucion', catalogo: CATALOGO, suscripcionConAcceso: false })).toBe('evolucion')
  })
  test('Inicial es gratis y no depende de la suscripción', () => {
    expect(planEfectivo({ contratado: 'inicial', catalogo: CATALOGO, suscripcionConAcceso: false })).toBe('inicial')
  })
  test('un plan pago vencido opera como Inicial', () => {
    expect(planEfectivo({ contratado: 'impulso', catalogo: CATALOGO, suscripcionConAcceso: true })).toBe('impulso')
    expect(planEfectivo({ contratado: 'impulso', catalogo: CATALOGO, suscripcionConAcceso: false })).toBe('inicial')
  })
  test('un código desconocido o vacío es Evolución (lo de siempre)', () => {
    expect(normalizarPlanCodigo(undefined)).toBe('evolucion')
    expect(normalizarPlanCodigo('premium')).toBe('evolucion')
    expect(normalizarPlanCodigo('escala')).toBe('escala')
  })
})

describe('módulos por plan', () => {
  test('Evolución incluye todo, incluso lo que no está en ninguna lista', () => {
    expect(planIncluyeModulo('evolucion', CATALOGO, 'multisucursal')).toBe(true)
    expect(planIncluyeModulo('inicial', CATALOGO, 'pos')).toBe(false)
    expect(planIncluyeModulo('esencial', CATALOGO, 'pos')).toBe(true)
  })
  test('el plan mínimo es el más barato que lo incluye', () => {
    expect(planMinimoParaModulo(CATALOGO, 'pos')).toBe('esencial')
    expect(planMinimoParaModulo(CATALOGO, 'estadisticas_avanzadas')).toBe('escala')
    expect(planMinimoParaModulo(CATALOGO, 'multisucursal')).toBe('evolucion')
  })
  test('capacidades del plan: siempre encendidas si el plan las incluye', () => {
    expect(esCapacidadPlan('codigo_fuente')).toBe(true)
    expect(moduloActivoEnPlan({ codigo: 'codigo_fuente', incluidoEnPlan: true, estadoFila: null, vigenteHasta: null })).toBe(true)
    expect(moduloActivoEnPlan({ codigo: 'codigo_fuente', incluidoEnPlan: false, estadoFila: null, vigenteHasta: null })).toBe(false)
  })
  test('herramientas del plan: se usan cuando el dueño las activa', () => {
    expect(moduloActivoEnPlan({ codigo: 'pos', incluidoEnPlan: true, estadoFila: null, vigenteHasta: null })).toBe(false)
    expect(moduloActivoEnPlan({ codigo: 'pos', incluidoEnPlan: true, estadoFila: 'activo', vigenteHasta: null })).toBe(true)
    // Activado en un plan que ya no tiene: la fila queda, pero el plan manda.
    expect(moduloActivoEnPlan({ codigo: 'pos', incluidoEnPlan: false, estadoFila: 'activo', vigenteHasta: null })).toBe(false)
  })
})

describe('Evolución conserva la política anterior, intacta', () => {
  const casos: PoliticaModuloInput[] = [
    { tipo: 'pago', estado: 'activo', origen: 'usuario', precioMensualCongelado: '30000', vigenteHasta: null, estadoSuscripcion: 'activa' },
    { tipo: 'pago', estado: 'activo', origen: 'usuario', precioMensualCongelado: '30000', vigenteHasta: null, estadoSuscripcion: 'trial' },
    { tipo: 'pago', estado: 'activo', origen: 'legacy', precioMensualCongelado: null, vigenteHasta: null, estadoSuscripcion: null },
    { tipo: 'incluido', estado: 'activo', origen: 'usuario', precioMensualCongelado: null, vigenteHasta: null, estadoSuscripcion: null },
    { tipo: 'incluido', estado: 'activo', origen: 'usuario', precioMensualCongelado: null, vigenteHasta: null, estadoSuscripcion: 'suspendida' },
    { tipo: 'incluido', estado: 'inactivo', origen: 'usuario', precioMensualCongelado: null, vigenteHasta: null, estadoSuscripcion: 'activa' },
    { tipo: 'pago', estado: 'cancelacion_programada', origen: 'usuario', precioMensualCongelado: '1', vigenteHasta: new Date(Date.now() - 1000), estadoSuscripcion: 'activa' },
  ]
  test('cada módulo de siempre da exactamente lo mismo que antes', () => {
    for (const politica of casos) {
      for (const codigo of ['pos', 'avisos_automaticos_whatsapp', 'multisucursal']) {
        expect(moduloActivoParaPlan({ esLegado: true }, { codigo, incluidoEnPlan: true, politica })).toBe(moduloEstaActivoAhora(politica))
      }
    }
  })
  test('las capacidades nuevas no le cierran nada que antes tenía abierto', () => {
    for (const politica of casos) {
      for (const codigo of ['diseno_personalizado', 'codigo_fuente', 'estadisticas_avanzadas', 'repositorio_propio']) {
        expect(moduloActivoParaPlan({ esLegado: true }, { codigo, incluidoEnPlan: true, politica })).toBe(true)
      }
    }
  })
  test('con un plan nuevo, un módulo pago incluido no pide pago ni suscripción', () => {
    const politica: PoliticaModuloInput = { tipo: 'pago', estado: 'activo', origen: 'usuario', precioMensualCongelado: null, vigenteHasta: null, estadoSuscripcion: null }
    expect(moduloActivoParaPlan({ esLegado: false }, { codigo: 'avisos_automaticos_whatsapp', incluidoEnPlan: true, politica })).toBe(true)
    expect(moduloActivoParaPlan({ esLegado: false }, { codigo: 'avisos_automaticos_whatsapp', incluidoEnPlan: false, politica })).toBe(false)
  })
})

describe('esquema pendiente', () => {
  test('tabla o columna faltante (también envuelta por Drizzle) → se trata como Evolución', () => {
    expect(esEsquemaPendiente({ code: 'ER_BAD_FIELD_ERROR' })).toBe(true)
    expect(esEsquemaPendiente(Object.assign(new Error('x'), { cause: { code: 'ER_NO_SUCH_TABLE' } }))).toBe(true)
    expect(esEsquemaPendiente({ code: 'ECONNREFUSED' })).toBe(false)
  })
})

describe('primeros pasos', () => {
  const base: DatosPasos = {
    productos: 0, whatsapp: null, horarios: 0, zonas: 0, deliveryEnabled: false, takeawayEnabled: true,
    direccion: null, mpConnected: false, transferenciaAlias: null, tieneSitio: false, disenoEnPlan: false,
  }
  test('una tienda recién creada sólo tiene hecho "Crear tienda"', () => {
    const pasos = calcularPasos(base)
    expect(pasos.filter((p) => p.hecho).map((p) => p.id)).toEqual(['crear_tienda'])
    expect(resumenPasos(pasos)).toEqual({ completados: 1, total: 6, terminado: false })
  })
  test('en Inicial el diseño es opcional y no frena terminar', () => {
    const pasos = calcularPasos({
      ...base, productos: 3, whatsapp: '5493511234567', horarios: 7, direccion: 'Calle 1', transferenciaAlias: 'mi.alias',
    })
    expect(resumenPasos(pasos).terminado).toBe(true)
    expect(pasos.find((p) => p.id === 'diseno')).toEqual({ id: 'diseno', hecho: false, opcional: true })
  })
  test('con Esencial el diseño cuenta y se completa al crear la página', () => {
    const conPlan = { ...base, disenoEnPlan: true }
    expect(calcularPasos(conPlan).find((p) => p.id === 'diseno')).toEqual({ id: 'diseno', hecho: false, opcional: false })
    expect(calcularPasos({ ...conPlan, tieneSitio: true }).find((p) => p.id === 'diseno')?.hecho).toBe(true)
  })
  test('entregas: delivery necesita zonas; retiro necesita la dirección', () => {
    expect(calcularPasos({ ...base, deliveryEnabled: true, takeawayEnabled: false, zonas: 0 }).find((p) => p.id === 'entregas')?.hecho).toBe(false)
    expect(calcularPasos({ ...base, deliveryEnabled: true, takeawayEnabled: false, zonas: 2 }).find((p) => p.id === 'entregas')?.hecho).toBe(true)
    expect(calcularPasos({ ...base, direccion: '  ' }).find((p) => p.id === 'entregas')?.hecho).toBe(false)
  })
})

describe('registro self-serve', () => {
  test('valida mail, marca, contraseña y términos', () => {
    expect(crearTiendaSchema.safeParse({ email: 'a@b.com', nombre: 'Dalto', password: '12345678', aceptaTerminos: true }).success).toBe(true)
    expect(crearTiendaSchema.safeParse({ email: 'a@b.com', nombre: 'Dalto', password: 'corta', aceptaTerminos: true }).success).toBe(false)
    expect(crearTiendaSchema.safeParse({ email: 'a@b.com', nombre: 'Dalto', password: '12345678', aceptaTerminos: false }).success).toBe(false)
    expect(crearTiendaSchema.parse({ email: ' A@B.com ', nombre: 'Dalto', password: '12345678', aceptaTerminos: true }).email).toBe('a@b.com')
  })
  test('nace en Inicial, sin paywall y con el onboarding asistido salteado', () => {
    const v = valoresTiendaNueva({ email: 'a@b.com', nombre: 'Dalto', password: 'x', aceptaTerminos: true }, 'hash', 'dalto')
    expect(v).toMatchObject({ planTienda: 'inicial', requiereSuscripcion: false, completedOnboarding: true, origen: 'self_serve', username: 'dalto', password: 'hash' })
  })
})

describe('Páginas: qué es editar código', () => {
  test('el editor visual sólo toca contenido.ts y fuentes.css', () => {
    const antes = { 'page.tsx': 'A', 'contenido.ts': '1', 'fuentes.css': '' }
    expect(cambiaCodigo(antes, { ...antes, 'contenido.ts': '2', 'fuentes.css': '@font-face{}' })).toBe(false)
    expect(cambiaCodigo(antes, { ...antes, 'page.tsx': 'B' })).toBe(true)
    expect(cambiaCodigo(antes, { ...antes, 'secciones/Nueva.tsx': 'x' })).toBe(true)
    const { 'page.tsx': _borrado, ...sinPage } = antes
    expect(cambiaCodigo(antes, sinPage)).toBe(true)
  })
})
