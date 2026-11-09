import { and, eq, isNotNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import * as jwt from 'jsonwebtoken'
import { timingSafeEqual } from 'node:crypto'
import { pool } from '../db'
import { categoria, producto, restaurante, sitioAsset, sitioTienda, sitioVersion } from '../db/schema'
import { esProspectoSinReclamar } from '../lib/demo-panel'
import { buildClaimUrl, claimTokenVigente, generarClaimLink } from '../lib/claim'
import { descargarImagenRemota } from '../lib/imagenes-remotas'
import { normalizarCartaJson, normalizarNegocioCartaJson } from '../lib/carta-json'
import { guardarImagenProductoImportada } from '../lib/producto-imagenes-r2'
import {
  candidatosUsername,
  circuloAPoligono,
  crearTiendaSchema,
  erroresDeZod,
  INSTRUCTIVO_TIENDA_JSON,
  leerDisenoZip,
  usernameBase,
  type TiendaProspecto,
} from '../lib/prospeccion-tienda'
import { almacenCloudflare } from '../lib/sitios-cloudflare'
import { marcarDespublicado } from '../lib/sitios-publicados'
import { LIMITES } from '../lib/sitios-reglas'
import { slugDisponible } from '../lib/sitios-slugs'
import { geocodificarDireccion } from '../services/geocoding'
import { cartaIaRoute } from './carta-ia'
import { internoRoute } from './interno'
import { onboardingRoute } from './onboarding'
import { sitiosRoute } from './sitios'
import { zonaDeliveryRoute } from './zona-delivery'

/**
 * API de servicio del servidor de prospección (`prospeccion/backend`). Ver
 * `prospeccion/docs/contrato-backend-piru.md`.
 *
 * Una API key fija (`PROSPECCION_API_KEY`) reemplaza a la sesión del dueño. No reimplementa nada:
 * cada paso llama en proceso a la ruta que ya usa la UI (onboarding, carta-ia, zona-delivery,
 * sitios) con una sesión de 15 minutos del local que se está armando, así sigue valiendo toda su
 * validación. Esa sesión nunca sale del backend ni se devuelve.
 *
 * Sólo opera sobre tiendas creadas por este canal (`prospecto_ref`) que siguen sin reclamar: una
 * tienda con dueño nunca se toca desde acá.
 */

const MY_PIRU = 'https://my.piru.app'
const norm = (s: string) => s.trim().toLowerCase()

const claveServicio = () => process.env.PROSPECCION_API_KEY ?? ''

const autenticar = createMiddleware(async (c, next) => {
  const esperada = claveServicio()
  if (esperada.length < 24) return c.json({ error: 'Canal de prospección no configurado' }, 503)
  const recibida = Buffer.from(c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? '')
  const buscada = Buffer.from(esperada)
  if (recibida.length !== buscada.length || !timingSafeEqual(recibida, buscada)) return c.json({ error: 'No autorizado' }, 401)
  await next()
})

/** Las rutas existentes, montadas con el mismo prefijo `/api` que en producción. */
const internas = new Hono()
  .route('/api/onboarding', onboardingRoute)
  .route('/api/carta-ia', cartaIaRoute)
  .route('/api/zona-delivery', zonaDeliveryRoute)
  .route('/api/sitios', sitiosRoute)
  .route('/api/interno', internoRoute)

const sesionLocal = (id: number, extra: Record<string, true>) =>
  jwt.sign({ id, scope: 'restaurante', ...extra }, process.env.JWT_SECRET || 'fallback-secret', { expiresIn: '15m' })

class PasoFallido extends Error {
  constructor(readonly errores: string[], readonly status = 422) {
    super(errores.join('; '))
  }
}

async function llamar(token: string, method: string, path: string, body?: unknown) {
  const esForm = body instanceof FormData
  const res = await internas.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && !esForm ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : esForm ? body : JSON.stringify(body),
  })
  const texto = await res.text()
  let json: any = null
  try {
    json = JSON.parse(texto)
  } catch {
    /* no es JSON */
  }
  return { ok: res.ok, status: res.status, json, texto }
}

/** Mensajes de error legibles de una respuesta de las rutas existentes. */
function mensajesDe(r: { json: any; texto: string; status: number }, paso: string): string[] {
  const j = r.json
  const lista: string[] = []
  if (Array.isArray(j?.errores)) lista.push(...j.errores.map(String))
  if (Array.isArray(j?.problemas)) lista.push(...j.problemas.map((p: any) => `${p.archivo ?? ''} ${p.mensaje ?? ''}`.trim()))
  for (const campo of ['message', 'error']) if (typeof j?.[campo] === 'string') lista.push(j[campo])
  return [`${paso}: ${lista.length ? lista.join('; ') : `error ${r.status}`}`]
}

async function exigir(paso: string, r: Awaited<ReturnType<typeof llamar>>) {
  if (!r.ok) throw new PasoFallido(mensajesDe(r, paso), r.status >= 500 ? 502 : 422)
  return r
}

const db = () => drizzle(pool)

/** Una tienda de este canal que sigue sin dueño; `null` si no existe o ya fue reclamada. */
async function tiendaProspecto(id: number) {
  const [local] = await db()
    .select({
      id: restaurante.id,
      username: restaurante.username,
      origen: restaurante.origen,
      claimedAt: restaurante.claimedAt,
      telefonoVerificado: restaurante.telefonoVerificado,
    })
    .from(restaurante)
    .where(and(eq(restaurante.id, id), isNotNull(restaurante.prospectoRef)))
    .limit(1)
  return local && esProspectoSinReclamar(local) ? local : null
}

async function sitioDe(restauranteId: number) {
  const [sitio] = await db().select().from(sitioTienda).where(eq(sitioTienda.restauranteId, restauranteId)).limit(1)
  return sitio ?? null
}

const urlTienda = (username: string | null, publicada: boolean) =>
  publicada ? `https://${username}.piru.app?demo` : `${MY_PIRU}/${username}?demo`

async function elegirUsername(propuesto: string | undefined, nombre: string): Promise<string> {
  for (const candidato of candidatosUsername(usernameBase(propuesto, nombre))) {
    if (!slugDisponible(candidato).ok) continue
    const [ocupado] = await db().select({ id: restaurante.id }).from(restaurante).where(eq(restaurante.username, candidato)).limit(1)
    if (!ocupado) return candidato
  }
  throw new PasoFallido(['No se encontró un username libre; proponé otro en negocio.username'], 409)
}

/** Copia a R2 las fotos de la carta ya creada. Un error de foto no aborta: queda como aviso. */
async function importarFotosCarta(restauranteId: number, carta: ReturnType<typeof normalizarCartaJson>, avisos: string[]) {
  const filas = await db()
    .select({ id: producto.id, nombre: producto.nombre, categoria: categoria.nombre })
    .from(producto)
    .leftJoin(categoria, eq(producto.categoriaId, categoria.id))
    .where(eq(producto.restauranteId, restauranteId))
  const idPor = new Map(filas.map((f) => [`${norm(f.categoria ?? '')}|${norm(f.nombre)}`, f.id]))

  const cola = carta.categorias.flatMap((cat) =>
    cat.productos
      .filter((p) => p.imagenUrl)
      .map((p) => ({ id: idPor.get(`${norm(cat.nombre)}|${norm(p.nombre.slice(0, 255))}`), nombre: p.nombre, urls: [p.imagenUrl!, ...p.imagenesExtra] })),
  )

  const trabajar = async () => {
    for (let item = cola.shift(); item; item = cola.shift()) {
      if (!item.id) continue
      const subidas: string[] = []
      for (const url of item.urls) {
        try {
          const d = await descargarImagenRemota(url)
          subidas.push(await guardarImagenProductoImportada(restauranteId, d.contenido, d.mime))
        } catch (e) {
          avisos.push(`Foto de "${item.nombre}" no importada: ${e instanceof Error ? e.message : 'error'}`)
        }
      }
      if (subidas.length)
        await db()
          .update(producto)
          .set({ imagenUrl: subidas[0], imagenesExtra: subidas.slice(1) })
          .where(eq(producto.id, item.id))
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, cola.length) }, trabajar))
}

/** Arma la tienda completa. Devuelve los datos finales; lanza `PasoFallido` si algo no sirve. */
async function armarTienda(id: number, username: string, t: TiendaProspecto, avisos: string[]) {
  const alta = sesionLocal(id, { altaInterna: true })
  const negocio = normalizarNegocioCartaJson(t.negocio)
  const telefono = negocio?.telefono ?? null
  const direccion = negocio?.direccion ?? undefined

  // Logo → R2 (como las fotos de producto).
  let logo: string | null = null
  if (negocio?.logoUrl) {
    try {
      const d = await descargarImagenRemota(negocio.logoUrl)
      logo = await guardarImagenProductoImportada(id, d.contenido, d.mime)
    } catch (e) {
      avisos.push(`Logo no importado: ${e instanceof Error ? e.message : 'error'}`)
    }
  }

  // Coordenadas: las del JSON o, si hay dirección, las de Google.
  let coords = negocio?.lat != null && negocio?.lng != null ? { lat: negocio.lat, lng: negocio.lng } : null
  if (!coords && direccion) {
    const g = await geocodificarDireccion(direccion)
    if (g.success) coords = { lat: g.lat, lng: g.lng }
    else avisos.push(`No se pudo ubicar la dirección: ${g.error}`)
  }
  if (coords)
    await db().update(restaurante).set({ direccionLat: String(coords.lat), direccionLng: String(coords.lng) }).where(eq(restaurante.id, id))

  await exigir(
    'Datos del local',
    await llamar(alta, 'PUT', '/api/onboarding/complete', {
      username,
      nombre: t.negocio.nombre,
      address: direccion,
      notifyWhatsapp: telefono != null,
      whatsappNumber: telefono ?? undefined,
      notifyPrinter: false,
      turnos: t.horarios.map((h) => ({ horaApertura: h.apertura, horaCierre: h.cierre })),
      deliveryPrice: String(t.entrega.precioEnvio),
      friendsOrdering: true,
      imageLight: logo,
      imageDark: logo,
      colorPrimario: t.colores.primario,
      colorSecundario: t.colores.secundario,
      usarColorUnico: t.colores.unico,
      finalizar: false,
      deliveryEnabled: t.entrega.delivery,
      takeawayEnabled: t.entrega.retiro,
      proveedorPago: 'manual',
      metodosPago: { efectivo: t.pagos.efectivo, transferenciaManual: t.pagos.transferencia },
      transferenciaAlias: t.pagos.transferencia ? (t.pagos.alias ?? '') : '',
    }),
  )

  const carta = normalizarCartaJson(t.carta)
  await exigir('Carta', await llamar(alta, 'POST', '/api/carta-ia/crear', { carta }))
  await importarFotosCarta(id, carta, avisos)

  if (t.entrega.delivery) {
    if (coords) {
      await exigir(
        'Zona de reparto',
        await llamar(alta, 'POST', '/api/zona-delivery/create', {
          nombre: 'Radio de reparto',
          precio: String(t.entrega.precioEnvio),
          poligono: circuloAPoligono(coords, t.entrega.radioMetros),
          color: '#FF7A00',
        }),
      )
    } else avisos.push('Sin zona de reparto: faltan la dirección o las coordenadas del local')
  }

  await exigir('Cierre del alta', await llamar(alta, 'POST', '/api/onboarding/terminar-alta'))

  const creado = await exigir('Sitio', await llamar(sesionLocal(id, { appSitios: true }), 'POST', '/api/sitios', {}))
  return { sitioId: Number(creado.json?.id) }
}

/** Borra una tienda de este canal: sitio publicado, filas del sitio y el local con todo lo suyo. */
async function borrarTienda(id: number) {
  const sitio = await sitioDe(id)
  if (sitio) {
    try {
      await almacenCloudflare.borrarManifiesto(sitio.slug)
      marcarDespublicado(sitio.slug)
      await almacenCloudflare.purgar(sitio.slug)
    } catch (e) {
      console.error('[prospeccion] No se pudo despublicar el sitio', sitio.slug, e)
    }
    await db().delete(sitioAsset).where(eq(sitioAsset.sitioId, sitio.id))
    await db().delete(sitioVersion).where(eq(sitioVersion.sitioId, sitio.id))
    await db().delete(sitioTienda).where(eq(sitioTienda.id, sitio.id))
  }
  const secreto = process.env.INTERNO_JWT_SECRET
  if (!secreto) throw new PasoFallido(['Falta INTERNO_JWT_SECRET para borrar la tienda'], 503)
  const r = await llamar(jwt.sign({ scope: 'interno' }, secreto, { expiresIn: '5m' }), 'DELETE', `/api/interno/locales/${id}`)
  if (!r.ok) throw new PasoFallido(mensajesDe(r, 'Borrado'), 502)
}

const falla = (c: Context, e: unknown, extra: Record<string, unknown> = {}) => {
  if (e instanceof PasoFallido) return c.json({ ok: false, errores: e.errores, ...extra }, e.status as 400)
  console.error('[prospeccion]', e)
  return c.json({ ok: false, errores: ['Error interno'], ...extra }, 500)
}

const idDe = (c: Context) => Number(c.req.param('id'))

export const prospeccionRoute = new Hono()
  .use('*', autenticar)

  // Instructivo para que el LLM arme el JSON de la tienda (incluye el de la carta).
  .get('/instructivo.md', (c) =>
    c.body(INSTRUCTIVO_TIENDA_JSON, 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' }),
  )

  // Crea la tienda completa desde el JSON. Idempotente por `prospectoRef`.
  .post('/tienda-desde-json', async (c) => {
    const parsed = crearTiendaSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ ok: false, errores: erroresDeZod(parsed.error) }, 400)
    const { prospectoRef, tienda } = parsed.data

    const [existente] = await db()
      .select({ id: restaurante.id, username: restaurante.username })
      .from(restaurante)
      .where(eq(restaurante.prospectoRef, prospectoRef))
      .limit(1)
    if (existente) {
      const sitio = await sitioDe(existente.id)
      if (!sitio) return c.json({ ok: false, errores: ['La tienda de este prospecto quedó a medias; borrala y reintentá'], tiendaId: existente.id }, 409)
      return c.json({ ok: true, existente: true, tiendaId: existente.id, username: existente.username, sitioId: sitio.id, avisos: [], url: urlTienda(existente.username, !!sitio.versionPublicadaId) })
    }

    let id: number | null = null
    try {
      const username = await elegirUsername(tienda.negocio.username, tienda.negocio.nombre)
      const [creado] = await db().insert(restaurante).values({
        prospectoRef,
        nombre: tienda.negocio.nombre,
        origen: 'outbound',
        requiereSuscripcion: true,
        telefonoVerificado: false,
        createdAt: new Date(),
      })
      id = Number(creado.insertId)
      const avisos: string[] = []
      const { sitioId } = await armarTienda(id, username, tienda, avisos)
      return c.json({ ok: true, existente: false, tiendaId: id, username, sitioId, avisos, url: urlTienda(username, false) }, 201)
    } catch (e) {
      // Una tienda a medias bloquearía el reintento con la misma clave: se deshace.
      if (id !== null) {
        try {
          await borrarTienda(id)
        } catch (limpieza) {
          console.error('[prospeccion] No se pudo deshacer la tienda', id, limpieza)
          return falla(c, e, { tiendaId: id, pendienteDeBorrar: true })
        }
      }
      return falla(c, e)
    }
  })

  .get('/tiendas/:id{[0-9]+}', async (c) => {
    const local = await tiendaProspecto(idDe(c))
    if (!local) return c.json({ error: 'Tienda no encontrada' }, 404)
    const sitio = await sitioDe(local.id)
    const publicada = !!sitio?.versionPublicadaId
    return c.json({
      tiendaId: local.id,
      username: local.username,
      sitioId: sitio?.id ?? null,
      estado: publicada ? 'publicada' : 'creada',
      url: urlTienda(local.username, publicada),
    })
  })

  // La misma guía para Claude que descarga el dueño en Páginas.
  // Link de reclamo para mandarle al dueño cuando acepta la demo. Reutiliza el vigente.
  .post('/tiendas/:id{[0-9]+}/claim', async (c) => {
    const local = await tiendaProspecto(idDe(c))
    if (!local) return c.json({ error: 'Tienda no encontrada o ya reclamada' }, 404)
    const [fila] = await db()
      .select({ claimToken: restaurante.claimToken, claimTokenExpira: restaurante.claimTokenExpira })
      .from(restaurante)
      .where(eq(restaurante.id, local.id))
      .limit(1)
    if (!fila) return c.json({ error: 'Tienda no encontrada' }, 404)
    if (fila.claimToken && claimTokenVigente(fila)) {
      return c.json({ url: buildClaimUrl(fila.claimToken), venceEn: fila.claimTokenExpira })
    }
    const claim = await generarClaimLink(db(), local.id)
    return c.json({ url: claim.url, venceEn: claim.expira })
  })

  // La misma guía para Claude que descarga el dueño en Páginas.
  .get('/tiendas/:id{[0-9]+}/guia.md', async (c) => {
    const local = await tiendaProspecto(idDe(c))
    const sitio = local && (await sitioDe(local.id))
    if (!local || !sitio) return c.json({ error: 'Tienda no encontrada' }, 404)
    const r = await llamar(sesionLocal(local.id, { appSitios: true }), 'GET', `/api/sitios/${sitio.id}/guia.md`)
    if (!r.ok) return c.json({ error: 'No se pudo generar la guía' }, 502)
    return c.body(r.texto, 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' })
  })

  // Recibe el .zip del diseño, reemplaza el borrador, sube los assets, compila y publica.
  .post('/tiendas/:id{[0-9]+}/diseno', async (c) => {
    const local = await tiendaProspecto(idDe(c))
    const sitio = local && (await sitioDe(local.id))
    if (!local || !sitio) return c.json({ error: 'Tienda no encontrada' }, 404)

    const archivo = (await c.req.formData().catch(() => null))?.get('archivo')
    if (!(archivo instanceof File)) return c.json({ ok: false, errores: ['Falta el campo "archivo" con el .zip'] }, 400)

    try {
      let diseno
      try {
        diseno = leerDisenoZip(new Uint8Array(await archivo.arrayBuffer()))
      } catch (e) {
        throw new PasoFallido([e instanceof Error ? e.message : 'Zip inválido'], 400)
      }
      if (diseno.assets.length > LIMITES.assets) throw new PasoFallido([`El .zip trae ${diseno.assets.length} assets; el máximo es ${LIMITES.assets}`], 400)

      const token = sesionLocal(local.id, { appSitios: true })
      await exigir(
        'Borrador',
        await llamar(token, 'PUT', `/api/sitios/${sitio.id}/borrador`, {
          archivos: diseno.codigo,
          borradorActualizadoAt: sitio.borradorActualizadoAt.toISOString(),
        }),
      )
      for (const asset of diseno.assets) {
        const form = new FormData()
        form.set('archivo', new File([asset.bytes as BlobPart], asset.path.split('/').pop()!))
        form.set('path', asset.path)
        await exigir(`Asset ${asset.path}`, await llamar(token, 'POST', `/api/sitios/${sitio.id}/assets`, form))
      }
      const pub = await llamar(token, 'POST', `/api/sitios/${sitio.id}/publicar`)
      if (!pub.ok) throw new PasoFallido(mensajesDe(pub, 'Compilación'))
      return c.json({ ok: true, url: urlTienda(local.username, true), numero: pub.json?.numero, advertencias: pub.json?.advertencias ?? [], ignorados: diseno.ignorados })
    } catch (e) {
      return falla(c, e)
    }
  })

  // La tienda demo se borra si el negocio dice que no.
  .delete('/tiendas/:id{[0-9]+}', async (c) => {
    const local = await tiendaProspecto(idDe(c))
    if (!local) return c.json({ error: 'Tienda no encontrada' }, 404)
    try {
      await borrarTienda(local.id)
      return c.json({ ok: true })
    } catch (e) {
      return falla(c, e)
    }
  })
