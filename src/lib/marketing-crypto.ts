import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

export interface GrowthTokenPayload {
  rId: number
  cId: number
  campana: 'lo_mismo' | 'reactivacion'
  modalidad: 'drawer_habitual' | 'descuento_banner'
  rep?: string
  dto?: number
  exp?: number | null
  nonce?: string
}

function resolverClaveSecreta(secretPersonalizado?: string): Buffer {
  const secret = secretPersonalizado || process.env.GROWTH_PAYLOAD_SECRET || process.env.JWT_SECRET || 'piru-growth-secret-fallback-key-32b'
  return createHash('sha256').update(secret).digest()
}

/**
 * Cifra un payload de crecimiento usando AES-256-GCM (cifrado autenticado AEAD).
 * Produce un token compacto en base64url seguro para ser usado en query params:
 * formato: v1.<iv_base64url>.<ciphertext_base64url>.<tag_base64url>
 */
export function cifrarGrowthPayload(payload: GrowthTokenPayload, secret?: string): string {
  const key = resolverClaveSecreta(secret)
  const iv = randomBytes(12) // 96 bits recomendado para GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv)

  const payloadNormalizado: GrowthTokenPayload = {
    ...payload,
    nonce: payload.nonce || randomBytes(6).toString('hex'),
  }

  const json = JSON.stringify(payloadNormalizado)
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`
}

/**
 * Descifra y valida la autenticidad e integridad del token de crecimiento.
 * Si el token fue adulterado o no coincide el AuthTag, retorna null inmediatamente.
 */
export function descifrarGrowthPayload(token: string, secret?: string): GrowthTokenPayload | null {
  if (!token || typeof token !== 'string') return null
  const partes = token.split('.')
  if (partes.length !== 4 || partes[0] !== 'v1') return null

  const [, ivStr, cipherStr, tagStr] = partes
  try {
    const key = resolverClaveSecreta(secret)
    const iv = Buffer.from(ivStr, 'base64url')
    const ciphertext = Buffer.from(cipherStr, 'base64url')
    const tag = Buffer.from(tagStr, 'base64url')

    if (iv.length !== 12 || tag.length !== 16) return null

    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    const parsed = JSON.parse(decrypted) as GrowthTokenPayload

    if (typeof parsed !== 'object' || parsed === null) return null
    if (typeof parsed.rId !== 'number' || typeof parsed.cId !== 'number') return null
    if (parsed.campana !== 'lo_mismo' && parsed.campana !== 'reactivacion') return null

    return parsed
  } catch {
    // Si la firma falla, tag incorrecto o JSON inválido
    return null
  }
}
