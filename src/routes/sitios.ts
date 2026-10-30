import { Hono, type Context } from 'hono'
import * as jwt from 'jsonwebtoken'
import { and, desc, eq, max } from 'drizzle-orm'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { createHash } from 'node:crypto'
import { pool } from '../db'
import { producto, restaurante, sitioAsset, sitioTienda, sitioVersion } from '../db/schema'
import { authMiddleware, type AuthenticatedContext } from '../middleware/auth'
import { construirSitio, urlAsset, type ResultadoBuild } from '../lib/sitios-build'
import {
  almacenCloudflare,
  claveAsset,
  claveBundle,
  ErrorConfiguracionSitios,
  type AlmacenSitios,
  type ManifiestoSitio,
  type MetaPublicada,
} from '../lib/sitios-cloudflare'
import { generarGuia } from '../lib/sitios-guia'
import { plantillaInicial } from '../lib/sitios-plantilla'
import { marcarDespublicado, marcarPublicado } from '../lib/sitios-publicados'
import {
  LIMITES,
  RUNTIME_VERSION,
  TIPOS_ASSET,
  esAsset,
  extension,
  pathValido,
  validarBorrador,
  type Borrador,
} from '../lib/sitios-reglas'
import { slugDisponible } from '../lib/sitios-slugs'
import { corto, normalizarMeta, type MetaSitio } from '../lib/sitios-meta'
import { archivoContenido, normalizarContenidoSitio, normalizarMarcaSitio, marcaPorDefecto, type ContenidoSitio } from '../lib/sitios-contenido'
import { imagenesTienda } from '../lib/tienda-imagenes-r2'
import { errorImagenDataUrl } from '../lib/producto-imagenes'
import { normalizarTienda } from '../lib/tienda-config'
import { publicRoute } from './public'

/**
 * Páginas: el editor de sitios propios (`pages.piru.app`). Ver docs/PAGINAS_PROPIAS.md, §11–14.
 *
 * - `POST /entrada` (sesión del panel) firma un pase de 2 minutos; `POST /sesion` lo canjea por una
 *   sesión de 12 h `{ id, scope:'restaurante', appSitios:true }` que `authMiddleware` limita a
 *   `/sitios/*` (`sitiosPuede`).
 * - Un sitio por local en la v1; el slug es el `username`. Todo se acota por el `restauranteId` de
 *   la identidad verificada.
 * - Publicar compila con `Bun.build` (subproceso), sube a R2, guarda la versión y escribe KV al
 *   final: si algo falla antes, lo publicado no cambia.
 */

const secreto = () => process.env.JWT_SECRET || 'fallback-secret'
const ENTRADA_TTL_SEGUNDOS = 120
const SESION_TTL_SEGUNDOS = 12 * 3600
const SCOPE_ENTRADA = 'entrada-sitios'
const ENTRADA_VENCIDA = { error: 'El acceso venció. Volvé a abrir Páginas desde tu panel de Piru.', code: 'entrada_vencida' }
export const urlPaginas = () => (process.env.PAGINAS_URL || 'https://pages.piru.app').replace(/\/$/, '')

type Dependencias = {
  getDb: () => MySql2Database
  almacen: AlmacenSitios
  auth: typeof authMiddleware
  construir: typeof construirSitio
  datosTienda: (restauranteId: number) => Promise<Record<string, unknown> | null>
}

const usuario = (c: Context) => (c as unknown as AuthenticatedContext).user

function leerJson<T>(v: unknown, porDefecto: T): T {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T
    } catch {
      return porDefecto
    }
  }
  return (v ?? porDefecto) as T
}

async function datosTiendaPublica(restauranteId: number) {
  const res = await publicRoute.request(`/restaurante/id/${restauranteId}`)
  if (!res.ok) return null
  const cuerpo = (await res.json()) as { data?: Record<string, unknown> }
  return cuerpo.data ?? null
}

export function createSitiosRoute(deps: Partial<Dependencias> = {}) {
  const { getDb, almacen, auth, construir, datosTienda }: Dependencias = {
    getDb: () => drizzle(pool),
    almacen: almacenCloudflare,
    auth: authMiddleware,
    construir: construirSitio,
    datosTienda: datosTiendaPublica,
    ...deps,
  }

  /** El sitio del local de la sesión, o `null`. Nunca el de otro local. */
  async function sitioPropio(c: Context, id?: number) {
    const restauranteId = usuario(c).id
    const condiciones = [eq(sitioTienda.restauranteId, restauranteId)]
    if (id !== undefined) condiciones.push(eq(sitioTienda.id, id))
    const [sitio] = await getDb().select().from(sitioTienda).where(and(...condiciones)).limit(1)
    return sitio ?? null
  }

  async function assetsDe(sitioId: number) {
    return getDb().select().from(sitioAsset).where(eq(sitioAsset.sitioId, sitioId))
  }

  /**
   * Los datos base del local para el paso de preferencias: marca, logos, productos y, si ya
   * existía una personalización de la tienda estándar, sus textos como punto de partida.
   */
  async function baseDe(restauranteId: number) {
    const db = getDb()
    const [local] = await db
      .select({
        id: restaurante.id,
        nombre: restaurante.nombre,
        username: restaurante.username,
        tienda: restaurante.tienda,
        colorPrimario: restaurante.colorPrimario,
        colorSecundario: restaurante.colorSecundario,
        usarColorUnico: restaurante.usarColorUnico,
        imagenUrl: restaurante.imagenUrl,
        imagenLightUrl: restaurante.imagenLightUrl,
      })
      .from(restaurante)
      .where(eq(restaurante.id, restauranteId))
      .limit(1)
    if (!local) return null
    const productos = await db
      .select({
        id: producto.id,
        nombre: producto.nombre,
        activo: producto.activo,
        soloCanjePuntos: producto.soloCanjePuntos,
        eventoSucursalId: producto.eventoSucursalId,
      })
      .from(producto)
      .where(eq(producto.restauranteId, restauranteId))
    return {
      nombre: local.nombre,
      username: local.username,
      tienda: normalizarTienda(local.tienda) ?? {},
      marca: marcaPorDefecto(local.colorPrimario, local.colorSecundario, local.usarColorUnico),
      logo: local.imagenUrl,
      logoClaro: local.imagenLightUrl,
      productos,
    }
  }

  class ContenidoInvalido extends Error {}

  /**
   * Convierte lo elegido en el paso de preferencias en el contenido que se escribe en
   * `contenido.ts`. Las imágenes con data URL se suben a R2; el resto queda como URL.
   */
  async function materializarContenido(entrada: unknown, local: Awaited<ReturnType<typeof baseDe>>, restauranteId: number): Promise<ContenidoSitio> {
    if (!local) throw new ContenidoInvalido('Local no encontrado')
    const imagenes = imagenesTienda(restauranteId)
    const t = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? { ...(entrada as Record<string, unknown>) } : {}
    const marca = normalizarMarcaSitio(t.marca, local.marca)
    const resolver = async (valor: unknown, previa: string | null): Promise<string | null> => {
      if (valor === undefined) return previa
      if (valor === null || valor === '') return null
      if (typeof valor !== 'string') return previa
      if (valor.startsWith('data:')) {
        const problema = errorImagenDataUrl(valor)
        if (problema) throw new ContenidoInvalido(problema)
        return imagenes.guardar(valor)
      }
      return /^(https:\/\/|\/(?!\/))/i.test(valor) ? valor : previa
    }

    if (typeof t.portadaUrl === 'string' && t.portadaUrl.startsWith('data:')) t.portadaUrl = await resolver(t.portadaUrl, null)
    if (Array.isArray(t.galeria)) {
      const galeria: string[] = []
      for (const foto of t.galeria) {
        const url = await resolver(foto, null)
        if (url) galeria.push(url)
      }
      t.galeria = galeria
    }
    t.logo = await resolver(t.logo, local.logo)
    t.logoClaro = await resolver(t.logoClaro, local.logoClaro)

    return normalizarContenidoSitio(
      { ...t, marca },
      { marca, logo: local.logo, logoClaro: local.logoClaro },
    )
  }

  const idParam = (c: Context) => {
    const id = Number(c.req.param('id'))
    return Number.isSafeInteger(id) && id > 0 ? id : null
  }

  function metaPublicada(
    meta: MetaSitio,
    assets: { path: string; sha: string }[],
    local: { nombre: string },
  ): MetaPublicada {
    const url = (path?: string) => {
      const asset = path ? assets.find((a) => a.path === path) : undefined
      return asset ? urlAsset(asset) : null
    }
    return {
      titulo: meta.titulo ?? local.nombre,
      descripcion: meta.descripcion ?? `Pedí online en ${local.nombre}.`,
      ogImage: url(meta.ogImage),
      icono: url(meta.icono),
      themeColor: meta.themeColor ?? meta.loadingBackground ?? null,
      loadingBackground: meta.loadingBackground ?? null,
    }
  }

  async function escribirEnVivo(
    sitio: typeof sitioTienda.$inferSelect,
    version: typeof sitioVersion.$inferSelect,
  ) {
    const bundle = version.bundleKey.match(/\/s\/([a-f0-9]+)\.js$/)?.[1]
    const css = version.cssKey?.match(/\/s\/([a-f0-9]+)\.css$/)?.[1] ?? null
    if (!bundle) throw new Error('Versión sin bundle')
    const manifiesto: ManifiestoSitio = {
      versionId: version.id,
      restauranteId: sitio.restauranteId,
      username: sitio.username,
      runtime: version.runtimeVersion,
      bundle,
      css,
      meta: leerJson<MetaPublicada>(version.meta, {
        titulo: sitio.nombre,
        descripcion: '',
        ogImage: null,
        icono: null,
        themeColor: null,
        loadingBackground: null,
      }),
      status: 'activo',
    }
    await almacen.escribirManifiesto(sitio.slug, manifiesto)
    marcarPublicado(sitio.slug)
    await almacen.purgar(sitio.slug)
  }

  const errorPublicacion = (c: Context, e: unknown) => {
    if (e instanceof ErrorConfiguracionSitios) return c.json({ error: e.message, code: 'sitios_sin_configurar' }, 503)
    console.error('[sitios] Error publicando:', e)
    return c.json({ error: 'No se pudo publicar. Lo publicado antes sigue en vivo; probá de nuevo.' }, 502)
  }

  return (
    new Hono()
      // ── Sesión ──
      .post('/sesion', async (c) => {
        const header = c.req.header('Authorization')
        let pase: jwt.JwtPayload = {}
        try {
          if (header?.startsWith('Bearer ')) pase = jwt.verify(header.slice(7), secreto()) as jwt.JwtPayload
        } catch {
          // Vencido o adulterado: la misma respuesta que sin pase.
        }
        const restauranteId = Number(pase.restauranteId)
        if (pase.scope !== SCOPE_ENTRADA || !Number.isSafeInteger(restauranteId) || restauranteId <= 0)
          return c.json(ENTRADA_VENCIDA, 401)
        const [local] = await getDb()
          .select({ id: restaurante.id })
          .from(restaurante)
          .where(eq(restaurante.id, restauranteId))
          .limit(1)
        if (!local) return c.json(ENTRADA_VENCIDA, 401)
        const vence = Math.min(Math.floor(Date.now() / 1000) + SESION_TTL_SEGUNDOS, Number(pase.hasta) || Infinity)
        if (vence <= Math.floor(Date.now() / 1000)) return c.json(ENTRADA_VENCIDA, 401)
        const token = jwt.sign({ id: local.id, scope: 'restaurante', appSitios: true, exp: vence }, secreto())
        return c.json({ token, expira: new Date(vence * 1000).toISOString(), restauranteId: local.id })
      })
      .use('*', auth)
      .post('/entrada', (c) => {
        const user = usuario(c)
        // La demo y el marketer no llegan acá (no está en sus listas); la sesión de Páginas tampoco.
        if (user.demo || user.marketerId !== undefined || user.appSitios)
          return c.json({ error: 'Esto se abre desde tu panel de Piru', code: 'sitios_sin_permiso' }, 403)
        const origen = jwt.decode(c.req.header('Authorization')!.slice(7)) as jwt.JwtPayload
        const token = jwt.sign(
          {
            scope: SCOPE_ENTRADA,
            restauranteId: user.id,
            // Un acceso temporal de interno no se estira a 12 horas.
            ...(origen.accesoTemporalInterno ? { hasta: origen.exp } : {}),
          },
          secreto(),
          { expiresIn: ENTRADA_TTL_SEGUNDOS },
        )
        return c.json({
          success: true,
          data: { url: `${urlPaginas()}/entrar#token=${encodeURIComponent(token)}` },
        })
      })

      // ── Sitio ──
      .get('/', async (c) => {
        const restauranteId = usuario(c).id
        const [local] = await getDb()
          .select({ id: restaurante.id, nombre: restaurante.nombre, username: restaurante.username })
          .from(restaurante)
          .where(eq(restaurante.id, restauranteId))
          .limit(1)
        const sitio = await sitioPropio(c)
        let publicada: { numero: number; createdAt: string } | null = null
        if (sitio?.versionPublicadaId) {
          const [v] = await getDb()
            .select({ numero: sitioVersion.numero, createdAt: sitioVersion.createdAt })
            .from(sitioVersion)
            .where(eq(sitioVersion.id, sitio.versionPublicadaId))
            .limit(1)
          if (v) publicada = { numero: v.numero, createdAt: v.createdAt.toISOString() }
        }
        return c.json({
          local: local ?? null,
          sitio: sitio
            ? {
                id: sitio.id,
                slug: sitio.slug,
                nombre: sitio.nombre,
                estado: sitio.estado,
                url: `https://${sitio.slug}.piru.app`,
                publicada,
                actualizadoAt: sitio.borradorActualizadoAt.toISOString(),
              }
            : null,
        })
      })
      .post('/', async (c) => {
        const restauranteId = usuario(c).id
        if (await sitioPropio(c)) return c.json({ error: 'Tu local ya tiene una página' }, 409)
        const local = await baseDe(restauranteId)
        if (!local) return c.json({ error: 'Local no encontrado' }, 404)
        if (!local.username)
          return c.json({ error: 'Primero elegí el link de tu tienda en Ajustes → General', code: 'sin_username' }, 400)
        const slug = local.username.toLowerCase()
        const disponible = slugDisponible(slug)
        if (!disponible.ok) return c.json({ error: disponible.motivo, code: 'slug_no_disponible' }, 400)

        // Lo elegido en preferencias no se guarda como configuración: se escribe en el borrador.
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        let contenido: ContenidoSitio
        try {
          contenido = await materializarContenido(body?.contenido, local, restauranteId)
        } catch (e) {
          if (e instanceof ContenidoInvalido) return c.json({ error: e.message }, 400)
          console.error('[sitios] Error preparando el contenido:', e)
          return c.json({ error: 'No se pudieron preparar las fotos del contenido.' }, 500)
        }

        const ahora = new Date()
        await getDb().insert(sitioTienda).values({
          restauranteId,
          slug,
          username: local.username,
          nombre: local.nombre ?? local.username,
          estado: 'activo',
          meta: {},
          borrador: plantillaInicial(contenido),
          borradorActualizadoAt: ahora,
          borradorActualizadoPor: restauranteId,
          createdAt: ahora,
          updatedAt: ahora,
        })
        const sitio = await sitioPropio(c)
        return c.json({ id: sitio!.id }, 201)
      })

      // ── Datos base y assets del contenido ──
      .get('/base', async (c) => {
        const base = await baseDe(usuario(c).id)
        if (!base) return c.json({ error: 'Local no encontrado' }, 404)
        return c.json(base, 200, { 'Cache-Control': 'no-store' })
      })
      .post('/imagenes', async (c) => {
        const body = (await c.req.json().catch(() => null)) as { data?: unknown } | null
        if (typeof body?.data !== 'string') return c.json({ error: 'Falta la imagen' }, 400)
        const problema = errorImagenDataUrl(body.data)
        if (problema) return c.json({ error: problema }, 400)
        try {
          const url = await imagenesTienda(usuario(c).id).guardar(body.data)
          return c.json({ url }, 201)
        } catch (e) {
          console.error('[sitios] Error subiendo una imagen de contenido:', e)
          return c.json({ error: 'No se pudo subir la imagen. Probá de nuevo.' }, 500)
        }
      })

      .get('/:id{[0-9]+}', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const assets = await assetsDe(sitio.id)
        return c.json({
          id: sitio.id,
          slug: sitio.slug,
          username: sitio.username,
          restauranteId: sitio.restauranteId,
          nombre: sitio.nombre,
          estado: sitio.estado,
          url: `https://${sitio.slug}.piru.app`,
          meta: leerJson<MetaSitio>(sitio.meta, {}),
          borrador: leerJson<Borrador>(sitio.borrador, {}),
          borradorActualizadoAt: sitio.borradorActualizadoAt.toISOString(),
          versionPublicadaId: sitio.versionPublicadaId,
          assets: assets.map((a) => ({ id: a.id, path: a.path, sha: a.sha, contentType: a.contentType, size: a.size, url: urlAsset(a) })),
        })
      })
      .patch('/:id{[0-9]+}', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        const cambios: Partial<typeof sitioTienda.$inferInsert> = { updatedAt: new Date() }
        if (body.nombre !== undefined) {
          const nombre = corto(body.nombre, 255)
          if (!nombre) return c.json({ error: 'Nombre inválido' }, 400)
          cambios.nombre = nombre
        }
        if (body.meta !== undefined) cambios.meta = normalizarMeta(body.meta)
        const estado = body.estado
        if (estado !== undefined && estado !== 'activo' && estado !== 'deshabilitado')
          return c.json({ error: 'Estado inválido' }, 400)
        try {
          if (estado === 'deshabilitado' && sitio.estado !== 'deshabilitado') {
            // El subdominio vuelve a la tienda estándar. Primero KV: si falla, nada cambia.
            await almacen.borrarManifiesto(sitio.slug)
            marcarDespublicado(sitio.slug)
            await almacen.purgar(sitio.slug)
          }
          if (estado === 'activo' && sitio.estado !== 'activo' && sitio.versionPublicadaId) {
            const [version] = await getDb().select().from(sitioVersion).where(eq(sitioVersion.id, sitio.versionPublicadaId)).limit(1)
            if (version) await escribirEnVivo(sitio, version)
          }
        } catch (e) {
          return errorPublicacion(c, e)
        }
        if (estado) cambios.estado = estado
        await getDb().update(sitioTienda).set(cambios).where(eq(sitioTienda.id, sitio.id))
        return c.json({ success: true })
      })
      .put('/:id{[0-9]+}/borrador', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const body = (await c.req.json().catch(() => null)) as { archivos?: unknown; borradorActualizadoAt?: unknown } | null
        if (typeof body?.borradorActualizadoAt !== 'string' || new Date(body.borradorActualizadoAt).getTime() !== sitio.borradorActualizadoAt.getTime())
          return c.json(
            {
              error: 'El borrador cambió en otra pestaña. Recargá para no pisar esos cambios.',
              code: 'borrador_desactualizado',
              borradorActualizadoAt: sitio.borradorActualizadoAt.toISOString(),
            },
            409,
          )
        const { borrador, problemas } = validarBorrador(body.archivos)
        if (problemas.length) return c.json({ error: 'El borrador no es válido', problemas }, 400)
        const ahora = new Date()
        await getDb()
          .update(sitioTienda)
          .set({ borrador, borradorActualizadoAt: ahora, borradorActualizadoPor: usuario(c).id, updatedAt: ahora })
          .where(and(eq(sitioTienda.id, sitio.id), eq(sitioTienda.borradorActualizadoAt, sitio.borradorActualizadoAt)))
        return c.json({ borradorActualizadoAt: ahora.toISOString() })
      })

      /**
       * Empezar de cero: reemplaza el borrador por la plantilla inicial con el contenido elegido.
       * No toca la versión publicada (sigue en vivo hasta que se publique de nuevo) ni los assets
       * subidos, así una versión anterior todavía se puede restaurar.
       */
      .post('/:id{[0-9]+}/reiniciar', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const local = await baseDe(sitio.restauranteId)
        if (!local) return c.json({ error: 'Local no encontrado' }, 404)
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        let contenido: ContenidoSitio
        try {
          contenido = await materializarContenido(body?.contenido, local, sitio.restauranteId)
        } catch (e) {
          if (e instanceof ContenidoInvalido) return c.json({ error: e.message }, 400)
          console.error('[sitios] Error preparando el contenido al reiniciar:', e)
          return c.json({ error: 'No se pudieron preparar las fotos del contenido.' }, 500)
        }
        const ahora = new Date()
        const borrador = plantillaInicial(contenido)
        await getDb()
          .update(sitioTienda)
          .set({ borrador, borradorActualizadoAt: ahora, borradorActualizadoPor: usuario(c).id, updatedAt: ahora })
          .where(eq(sitioTienda.id, sitio.id))
        return c.json({ borrador, borradorActualizadoAt: ahora.toISOString() })
      })

      // ── Assets ──
      .post('/:id{[0-9]+}/assets', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const form = await c.req.formData().catch(() => null)
        const archivo = form?.get('archivo')
        const path = String(form?.get('path') ?? '')
        if (!(archivo instanceof File)) return c.json({ error: 'Falta el archivo' }, 400)
        if (!pathValido(path) || !esAsset(path))
          return c.json({ error: `El asset tiene que ir en assets/ y ser ${Object.keys(TIPOS_ASSET).join(', ')}` }, 400)
        if (archivo.size > LIMITES.assetBytes) return c.json({ error: 'El archivo supera 8 MB' }, 400)
        const existentes = await assetsDe(sitio.id)
        if (existentes.length >= LIMITES.assets && !existentes.some((a) => a.path === path))
          return c.json({ error: `Un sitio admite hasta ${LIMITES.assets} assets` }, 400)
        const bytes = new Uint8Array(await archivo.arrayBuffer())
        const ext = extension(path)
        const contentType = TIPOS_ASSET[ext]
        const sha = createHash('sha256').update(bytes).digest('hex')
        const r2Key = claveAsset(sitio.username, sha, ext)
        try {
          // Content-addressed: el mismo archivo no se sube dos veces.
          if (!(await almacen.existe(r2Key))) await almacen.subir(r2Key, bytes, contentType)
        } catch (e) {
          return errorPublicacion(c, e)
        }
        const ahora = new Date()
        const previo = existentes.find((a) => a.path === path)
        if (previo)
          await getDb().update(sitioAsset).set({ sha, r2Key, contentType, size: bytes.byteLength, createdAt: ahora }).where(eq(sitioAsset.id, previo.id))
        else
          await getDb().insert(sitioAsset).values({ sitioId: sitio.id, restauranteId: sitio.restauranteId, path, sha, r2Key, contentType, size: bytes.byteLength, createdAt: ahora })
        const [asset] = await getDb().select().from(sitioAsset).where(and(eq(sitioAsset.sitioId, sitio.id), eq(sitioAsset.path, path))).limit(1)
        return c.json({ id: asset.id, path, sha, contentType, size: bytes.byteLength, url: urlAsset(asset) }, 201)
      })
      .get('/:id{[0-9]+}/assets/:assetId{[0-9]+}', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const [asset] = await getDb()
          .select()
          .from(sitioAsset)
          .where(and(eq(sitioAsset.id, Number(c.req.param('assetId'))), eq(sitioAsset.sitioId, sitio.id)))
          .limit(1)
        if (!asset) return c.json({ error: 'Asset no encontrado' }, 404)
        const objeto = await almacen.leer(asset.r2Key).catch(() => null)
        if (!objeto) return c.json({ error: 'Asset no encontrado' }, 404)
        return new Response(new Blob([objeto.cuerpo as BlobPart]), {
          headers: {
            'Content-Type': asset.contentType,
            'Cache-Control': 'private, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          },
        })
      })
      .delete('/:id{[0-9]+}/assets/:assetId{[0-9]+}', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        // Sólo sale del borrador: R2 lo conserva mientras alguna versión lo use.
        await getDb()
          .delete(sitioAsset)
          .where(and(eq(sitioAsset.id, Number(c.req.param('assetId'))), eq(sitioAsset.sitioId, sitio.id)))
        return c.json({ success: true })
      })

      // ── Build y publicación ──
      .post('/:id{[0-9]+}/build', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const resultado = await construir(leerJson<Borrador>(sitio.borrador, {}), await assetsDe(sitio.id))
        return c.json(
          resultado.ok
            ? { ok: true, advertencias: resultado.advertencias, jsBytes: resultado.js.length, cssBytes: resultado.css?.length ?? 0 }
            : { ok: false, errores: resultado.errores },
        )
      })
      .post('/:id{[0-9]+}/publicar', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const borrador = leerJson<Borrador>(sitio.borrador, {})
        const { problemas } = validarBorrador(borrador)
        if (problemas.length) return c.json({ ok: false, errores: problemas.map((p) => `${p.archivo ?? ''} ${p.mensaje}`.trim()) }, 400)
        const assets = await assetsDe(sitio.id)
        const resultado: ResultadoBuild = await construir(borrador, assets)
        if (!resultado.ok) return c.json({ ok: false, errores: resultado.errores }, 400)

        const db = getDb()
        const [local] = await db
          .select({ nombre: restaurante.nombre, dominioTienda: restaurante.dominioTienda })
          .from(restaurante)
          .where(eq(restaurante.id, sitio.restauranteId))
          .limit(1)
        const meta = leerJson<MetaSitio>(sitio.meta, {})
        const metaPub = metaPublicada(meta, assets, { nombre: local?.nombre ?? sitio.nombre })
        const usados = new Set([...resultado.assetsUsados, meta.ogImage, meta.icono].filter(Boolean) as string[])

        let version: typeof sitioVersion.$inferSelect
        try {
          // 1. R2: bundle y CSS (los assets ya se subieron al cargarlos).
          const bundleKey = claveBundle(sitio.username, resultado.jsHash, 'js')
          const cssKey = resultado.css && resultado.cssHash ? claveBundle(sitio.username, resultado.cssHash, 'css') : null
          await almacen.subir(bundleKey, resultado.js, 'text/javascript; charset=utf-8')
          if (cssKey) await almacen.subir(cssKey, resultado.css!, 'text/css; charset=utf-8')

          // 2. Versión inmutable.
          const [{ ultimo }] = await db.select({ ultimo: max(sitioVersion.numero) }).from(sitioVersion).where(eq(sitioVersion.sitioId, sitio.id))
          const ahora = new Date()
          await db.insert(sitioVersion).values({
            sitioId: sitio.id,
            restauranteId: sitio.restauranteId,
            numero: (ultimo ?? 0) + 1,
            archivos: {
              codigo: borrador,
              assets: assets.filter((a) => usados.has(a.path)).map((a) => ({ path: a.path, sha: a.sha, r2Key: a.r2Key, contentType: a.contentType })),
              meta,
            },
            runtimeVersion: RUNTIME_VERSION,
            bundleKey,
            cssKey,
            meta: metaPub,
            buildLog: resultado.advertencias.join('\n') || null,
            creadoPor: usuario(c).id,
            createdAt: ahora,
          })
          ;[version] = await db
            .select()
            .from(sitioVersion)
            .where(and(eq(sitioVersion.sitioId, sitio.id), eq(sitioVersion.numero, (ultimo ?? 0) + 1)))
            .limit(1)
          await db.update(sitioTienda).set({ versionPublicadaId: version.id, estado: 'activo', updatedAt: ahora }).where(eq(sitioTienda.id, sitio.id))
        } catch (e) {
          return errorPublicacion(c, e)
        }

        // 3. KV al final: hasta acá, lo que está en vivo no cambió.
        try {
          await escribirEnVivo(sitio, version)
        } catch (e) {
          console.error('[sitios] La versión quedó guardada pero no se pudo poner en vivo:', e)
          return c.json(
            { ok: false, errores: ['La versión quedó guardada pero no se pudo poner en vivo. Probá publicar de nuevo.'], versionId: version.id },
            502,
          )
        }

        // El ancla pública del local pasa a ser el sitio, salvo que ya tenga un dominio propio.
        if (!local?.dominioTienda?.trim())
          await db.update(restaurante).set({ dominioTienda: `${sitio.slug}.piru.app` }).where(eq(restaurante.id, sitio.restauranteId))

        return c.json({ ok: true, url: `https://${sitio.slug}.piru.app`, versionId: version.id, numero: version.numero, advertencias: resultado.advertencias })
      })
      .get('/:id{[0-9]+}/versiones', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const versiones = await getDb()
          .select({ id: sitioVersion.id, numero: sitioVersion.numero, createdAt: sitioVersion.createdAt, creadoPor: sitioVersion.creadoPor, buildLog: sitioVersion.buildLog })
          .from(sitioVersion)
          .where(eq(sitioVersion.sitioId, sitio.id))
          .orderBy(desc(sitioVersion.numero))
          .limit(100)
        return c.json(versiones.map((v) => ({ ...v, createdAt: v.createdAt.toISOString(), publicada: v.id === sitio.versionPublicadaId })))
      })
      .post('/:id{[0-9]+}/versiones/:vid{[0-9]+}/publicar', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const [version] = await getDb()
          .select()
          .from(sitioVersion)
          .where(and(eq(sitioVersion.id, Number(c.req.param('vid'))), eq(sitioVersion.sitioId, sitio.id)))
          .limit(1)
        if (!version) return c.json({ error: 'Versión no encontrada' }, 404)
        // Rollback: sin recompilar; los bundles viejos siguen en R2.
        try {
          await escribirEnVivo(sitio, version)
        } catch (e) {
          return errorPublicacion(c, e)
        }
        await getDb().update(sitioTienda).set({ versionPublicadaId: version.id, estado: 'activo', updatedAt: new Date() }).where(eq(sitioTienda.id, sitio.id))
        return c.json({ ok: true, numero: version.numero })
      })
      .post('/:id{[0-9]+}/versiones/:vid{[0-9]+}/restaurar', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const [version] = await getDb()
          .select({ archivos: sitioVersion.archivos })
          .from(sitioVersion)
          .where(and(eq(sitioVersion.id, Number(c.req.param('vid'))), eq(sitioVersion.sitioId, sitio.id)))
          .limit(1)
        if (!version) return c.json({ error: 'Versión no encontrada' }, 404)
        const archivos = leerJson<{ codigo?: Borrador; assets?: { path: string; sha: string; r2Key: string; contentType: string }[]; meta?: MetaSitio }>(version.archivos, {})
        const ahora = new Date()
        const db = getDb()
        await db
          .update(sitioTienda)
          .set({ borrador: archivos.codigo ?? {}, ...(archivos.meta ? { meta: archivos.meta } : {}), borradorActualizadoAt: ahora, borradorActualizadoPor: usuario(c).id, updatedAt: ahora })
          .where(eq(sitioTienda.id, sitio.id))
        // Los assets que usaba esa versión vuelven al borrador (siguen en R2).
        const actuales = await assetsDe(sitio.id)
        for (const a of archivos.assets ?? []) {
          const previo = actuales.find((x) => x.path === a.path)
          if (previo?.sha === a.sha) continue
          if (previo) await db.update(sitioAsset).set({ sha: a.sha, r2Key: a.r2Key, contentType: a.contentType }).where(eq(sitioAsset.id, previo.id))
          else await db.insert(sitioAsset).values({ sitioId: sitio.id, restauranteId: sitio.restauranteId, path: a.path, sha: a.sha, r2Key: a.r2Key, contentType: a.contentType, size: 0, createdAt: ahora })
        }
        return c.json({ ok: true, borradorActualizadoAt: ahora.toISOString() })
      })

      // ── Datos para el editor ──
      .get('/:id{[0-9]+}/datos-preview', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const datos = await datosTienda(sitio.restauranteId)
        if (!datos) return c.json({ error: 'No se pudieron leer los datos de la tienda' }, 502)
        return c.json(datos, 200, { 'Cache-Control': 'no-store' })
      })
      .get('/:id{[0-9]+}/guia.md', async (c) => {
        const sitio = await sitioPropio(c, idParam(c) ?? 0)
        if (!sitio) return c.json({ error: 'Sitio no encontrado' }, 404)
        const datos = (await datosTienda(sitio.restauranteId)) ?? {}
        const assets = await assetsDe(sitio.id)
        const borrador = leerJson<Borrador>(sitio.borrador, {})
        const restauranteDatos = (datos.restaurante as Record<string, unknown>) ?? {}
        // Una página anterior a `contenido.ts` igual recibe en la guía el contenido de su tienda estándar.
        const contenidoGuia =
          borrador['contenido.ts'] ??
          archivoContenido(
            normalizarContenidoSitio(restauranteDatos.tienda, {
              marca: marcaPorDefecto(
                typeof restauranteDatos.colorPrimario === 'string' ? restauranteDatos.colorPrimario : null,
                typeof restauranteDatos.colorSecundario === 'string' ? restauranteDatos.colorSecundario : null,
                restauranteDatos.usarColorUnico === true,
              ),
              logo: typeof restauranteDatos.imagenUrl === 'string' ? restauranteDatos.imagenUrl : null,
              logoClaro: typeof restauranteDatos.imagenLightUrl === 'string' ? restauranteDatos.imagenLightUrl : null,
            }),
          )
        const md = generarGuia({
          nombre: String(restauranteDatos.nombre ?? sitio.nombre),
          username: sitio.username,
          restaurante: restauranteDatos,
          productos: (datos.productos as Record<string, unknown>[]) ?? [],
          horarios: (datos.horarios as unknown[]) ?? [],
          assets: assets.map((a) => a.path),
          contenido: contenidoGuia,
        })
        return c.body(md, 200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="piru-paginas-${sitio.username}.md"`,
        })
      })
  )
}

export const sitiosRoute = createSitiosRoute()
