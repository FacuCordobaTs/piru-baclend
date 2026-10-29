import { Hono, type Context } from 'hono'
import * as jwt from 'jsonwebtoken'
import { and, desc, eq, max, ne } from 'drizzle-orm'
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
import { PLANTILLA_INICIAL } from '../lib/sitios-plantilla'
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
import { baseTiendaDe } from '../lib/marketing-enlaces'
import { errorImagenDataUrl } from '../lib/producto-imagenes'
import { actualizarTienda, ImagenTiendaInvalida, normalizarTienda } from '../lib/tienda-config'
import { imagenesTienda } from '../lib/tienda-imagenes-r2'
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
   * La personalización de la tienda (`restaurante.tienda`, marca y fotos) para la app de Páginas.
   * Es el mismo contrato que usaba Ajustes → Tienda, ahora administrado desde `pages.piru.app`.
   */
  async function preferenciasDe(restauranteId: number) {
    const db = getDb()
    const [local] = await db
      .select({
        id: restaurante.id,
        nombre: restaurante.nombre,
        username: restaurante.username,
        dominioTienda: restaurante.dominioTienda,
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
      tienda: normalizarTienda(local.tienda) ?? {},
      marca: {
        colorPrimario: local.colorPrimario || '#FF7A00',
        colorSecundario: local.colorSecundario || '#FFFFFF',
        usarColorUnico: local.usarColorUnico === true,
      },
      username: local.username,
      nombre: local.nombre,
      baseTienda: baseTiendaDe(local),
      logo: local.imagenUrl,
      logoClaro: local.imagenLightUrl,
      productos,
    }
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
        const db = getDb()
        const [local] = await db
          .select({ username: restaurante.username, nombre: restaurante.nombre })
          .from(restaurante)
          .where(eq(restaurante.id, restauranteId))
          .limit(1)
        if (!local?.username)
          return c.json({ error: 'Primero elegí el link de tu tienda en las preferencias de Páginas', code: 'sin_username' }, 400)
        const slug = local.username.toLowerCase()
        const disponible = slugDisponible(slug)
        if (!disponible.ok) return c.json({ error: disponible.motivo, code: 'slug_no_disponible' }, 400)
        const ahora = new Date()
        await db.insert(sitioTienda).values({
          restauranteId,
          slug,
          username: local.username,
          nombre: local.nombre ?? local.username,
          estado: 'activo',
          meta: {},
          borrador: PLANTILLA_INICIAL,
          borradorActualizadoAt: ahora,
          borradorActualizadoPor: restauranteId,
          createdAt: ahora,
          updatedAt: ahora,
        })
        const sitio = await sitioPropio(c)
        return c.json({ id: sitio!.id }, 201)
      })

      // ── Preferencias de la tienda (antes Ajustes → Tienda) ──
      .get('/tienda', async (c) => {
        const preferencias = await preferenciasDe(usuario(c).id)
        if (!preferencias) return c.json({ error: 'Local no encontrado' }, 404)
        return c.json(preferencias, 200, { 'Cache-Control': 'no-store' })
      })
      .put('/tienda', async (c) => {
        const restauranteId = usuario(c).id
        const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
        if (!body || typeof body !== 'object') return c.json({ error: 'Cuerpo inválido' }, 400)
        const db = getDb()
        const [actual] = await db.select().from(restaurante).where(eq(restaurante.id, restauranteId)).limit(1)
        if (!actual) return c.json({ error: 'Local no encontrado' }, 404)

        const cambios: Partial<typeof restaurante.$inferInsert> = {}
        const marca = (body.marca && typeof body.marca === 'object' && !Array.isArray(body.marca) ? body.marca : {}) as Record<string, unknown>
        const color = (v: unknown) => (typeof v === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(v.trim()) ? v.trim() : null)
        for (const [campo, columna, etiqueta] of [
          ['colorPrimario', 'colorPrimario', 'El color primario'],
          ['colorSecundario', 'colorSecundario', 'El color secundario'],
        ] as const) {
          if (marca[campo] === undefined) continue
          const valor = color(marca[campo])
          if (!valor) return c.json({ error: `${etiqueta} tiene que ser un color hexadecimal, por ejemplo #FF7A00.` }, 400)
          cambios[columna] = valor
        }
        if (marca.usarColorUnico !== undefined) {
          if (typeof marca.usarColorUnico !== 'boolean') return c.json({ error: '«Usar un solo color» tiene que ser sí o no.' }, 400)
          cambios.usarColorUnico = marca.usarColorUnico
        }

        if (body.username !== undefined) {
          const username = String(body.username ?? '').trim().toLowerCase()
          if (username.length < 3) return c.json({ error: 'Usá al menos 3 caracteres para el link.' }, 400)
          if (!/^[a-z0-9_-]+$/.test(username)) return c.json({ error: 'El link sólo puede tener letras, números, guiones y guiones bajos.' }, 400)
          if (username !== actual.username) {
            // El slug del sitio y las claves de R2 se arman con el username. Con una página ya
            // creada, cambiarlo es una tarea coordinada (docs/PAGINAS_PROPIAS.md §17).
            const [sitio] = await db
              .select({ id: sitioTienda.id })
              .from(sitioTienda)
              .where(eq(sitioTienda.restauranteId, restauranteId))
              .limit(1)
            if (sitio)
              return c.json(
                { error: 'El link de una página ya creada se cambia con soporte: escribinos y lo coordinamos.', code: 'username_con_sitio' },
                409,
              )
            const disponible = slugDisponible(username)
            if (!disponible.ok) return c.json({ error: disponible.motivo, code: 'slug_no_disponible' }, 400)
            const [existente] = await db
              .select({ id: restaurante.id })
              .from(restaurante)
              .where(and(eq(restaurante.username, username), ne(restaurante.id, restauranteId)))
              .limit(1)
            if (existente) return c.json({ error: 'Ese link ya está en uso. Probá con otro.' }, 409)
            cambios.username = username
          }
        }

        // Logos: se suben al mismo namespace de fotos de la tienda y se borran los anteriores
        // recién después de confirmar la escritura.
        const imagenes = imagenesTienda(restauranteId)
        const nuevas: string[] = []
        const retiradas: string[] = []
        try {
          for (const [clave, columna, previa] of [
            ['logo', 'imagenUrl', actual.imagenUrl],
            ['logoClaro', 'imagenLightUrl', actual.imagenLightUrl],
          ] as const) {
            const valor = body[clave]
            if (valor === undefined) continue
            if (valor === null || valor === '') {
              cambios[columna] = null
              if (previa) retiradas.push(previa)
              continue
            }
            if (typeof valor !== 'string' || !valor.startsWith('data:'))
              return c.json({ error: 'Los logos se suben como imagen JPG, PNG o WebP.' }, 400)
            const problema = errorImagenDataUrl(valor)
            if (problema) return c.json({ error: problema }, 400)
            const url = await imagenes.guardar(valor)
            nuevas.push(url)
            cambios[columna] = url
            if (previa) retiradas.push(previa)
          }

          const tocaTienda = Object.hasOwn(body, 'tienda')
          const persistir = async (config?: unknown) => {
            if (tocaTienda) cambios.tienda = config as typeof cambios.tienda
            if (Object.keys(cambios).length)
              await db.update(restaurante).set(cambios).where(eq(restaurante.id, restauranteId))
          }
          if (tocaTienda) await actualizarTienda(body.tienda, actual.tienda, imagenes, persistir)
          else await persistir()
        } catch (e) {
          await Promise.allSettled(nuevas.map((url) => imagenes.borrar(url)))
          if (e instanceof ImagenTiendaInvalida) return c.json({ error: e.message }, 400)
          console.error('[sitios] Error guardando las preferencias:', e)
          return c.json({ error: 'No se pudieron guardar las preferencias. Probá de nuevo.' }, 500)
        }
        await Promise.allSettled(retiradas.map((url) => imagenes.borrar(url)))

        const preferencias = await preferenciasDe(restauranteId)
        return c.json(preferencias!)
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
        const restauranteDatos = (datos.restaurante as Record<string, unknown>) ?? {}
        const md = generarGuia({
          nombre: String(restauranteDatos.nombre ?? sitio.nombre),
          username: sitio.username,
          restaurante: restauranteDatos,
          productos: (datos.productos as Record<string, unknown>[]) ?? [],
          horarios: (datos.horarios as unknown[]) ?? [],
          assets: assets.map((a) => a.path),
        })
        return c.body(md, 200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="piru-paginas-${sitio.username}.md"`,
        })
      })
  )
}

export const sitiosRoute = createSitiosRoute()
