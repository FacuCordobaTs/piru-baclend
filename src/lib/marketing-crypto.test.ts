import { describe, it, expect } from 'vitest'
import { cifrarGrowthPayload, descifrarGrowthPayload, type GrowthTokenPayload } from './marketing-crypto'

describe('marketing-crypto (AES-256-GCM)', () => {
  const payloadBase: GrowthTokenPayload = {
    rId: 10,
    cId: 482,
    campana: 'lo_mismo',
    modalidad: 'drawer_habitual',
    rep: '12x2-15x1',
    dto: 0,
    exp: null,
  }

  it('cifra y descifra correctamente un payload válido', () => {
    const token = cifrarGrowthPayload(payloadBase)
    expect(typeof token).toBe('string')
    expect(token.startsWith('v1.')).toBe(true)

    const descifrado = descifrarGrowthPayload(token)
    expect(descifrado).not.toBeNull()
    expect(descifrado?.rId).toBe(10)
    expect(descifrado?.cId).toBe(482)
    expect(descifrado?.campana).toBe('lo_mismo')
    expect(descifrado?.modalidad).toBe('drawer_habitual')
    expect(descifrado?.rep).toBe('12x2-15x1')
    expect(descifrado?.dto).toBe(0)
    expect(typeof descifrado?.nonce).toBe('string')
  })

  it('cifra y descifra correctamente con descuentos y expiración', () => {
    const expira = Date.now() + 1000 * 60 * 60 * 48 // 48 hs
    const payloadDescuento: GrowthTokenPayload = {
      rId: 25,
      cId: 999,
      campana: 'reactivacion',
      modalidad: 'descuento_banner',
      dto: 20,
      exp: expira,
    }

    const token = cifrarGrowthPayload(payloadDescuento)
    const descifrado = descifrarGrowthPayload(token)
    expect(descifrado?.campana).toBe('reactivacion')
    expect(descifrado?.modalidad).toBe('descuento_banner')
    expect(descifrado?.dto).toBe(20)
    expect(descifrado?.exp).toBe(expira)
  })

  it('falla si el token fue manipulado / adulterado (tamper resistance)', () => {
    const token = cifrarGrowthPayload(payloadBase)
    const partes = token.split('.')

    // Modificamos un carácter del ciphertext
    const cipherModificado = partes[2].slice(0, -1) + (partes[2].endsWith('a') ? 'b' : 'a')
    const tokenAdulterado = `${partes[0]}.${partes[1]}.${cipherModificado}.${partes[3]}`

    const resultado = descifrarGrowthPayload(tokenAdulterado)
    expect(resultado).toBeNull()
  })

  it('falla con clave secreta diferente', () => {
    const token = cifrarGrowthPayload(payloadBase, 'clave-secreta-1')
    const resultado = descifrarGrowthPayload(token, 'clave-secreta-2')
    expect(resultado).toBeNull()
  })

  it('rechaza tokens con formato inválido o basura', () => {
    expect(descifrarGrowthPayload('')).toBeNull()
    expect(descifrarGrowthPayload('v1.invalido')).toBeNull()
    expect(descifrarGrowthPayload('v2.a.b.c')).toBeNull()
    expect(descifrarGrowthPayload('algo-completamente-random')).toBeNull()
  })
})
