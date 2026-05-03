// services/afip-billing.ts
// Servicio de facturación electrónica ARCA via AfipSDK
// Integrar en el endpoint PUT /:id/estado cuando estado === 'delivered'

import Afip from '@afipsdk/afip.js'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface RestauranteAfipConfig {
  cuit: string           // CUIT del restaurante (sin guiones)
  claveFiscal: string    // Contraseña de ARCA (guardada encriptada en DB, pasarla ya desencriptada)
  cert: string           // Contenido del .crt (texto plano)
  key: string            // Contenido del .key/.pem (texto plano)
  nombreFantasia: string // Nombre del restaurante para el punto de venta
  puntoDeVenta?: number  // Si ya existe en DB, pasarlo. Si no, se crea automáticamente.
}

export interface PedidoParaFacturar {
  id: number
  total: number          // Total del pedido en pesos (ya con IVA incluido si aplica)
  nombreCliente?: string | null
  // Agregar DNI del cliente acá cuando lo tengas en el futuro
}

export interface ResultadoFactura {
  cae: string
  caeFchVto: string
  puntoDeVenta: number
  numeroComprobante: number
}

// ─── Constantes ───────────────────────────────────────────────────────────────

// Para gastronomía: factura B, consumidor final, concepto productos
const TIPO_COMPROBANTE = 6   // Factura B
const CONCEPTO = 1           // Productos
const DOC_TIPO = 99          // Consumidor final
const DOC_NRO = 0            // Sin número de documento
const CONDICION_IVA = 5      // Consumidor final

// Para Factura B (responsable inscripto vendiendo a consumidor final):
// El total incluye IVA. AfipSDK necesita desglose neto + IVA.
// Gastronomía Argentina: alimentos y bebidas sin alcohol → 10.5% | con alcohol → 21%
// Por simplicidad usamos 21%. Ajustar si necesitás discriminar por producto.
const IVA_ALICUOTA_ID = 5   // 5 = 21%
const IVA_RATE = 0.21

// ─── Helper: calcular importes con IVA incluido ───────────────────────────────

function calcularImportes(totalConIva: number) {
  // total = neto * (1 + IVA)  →  neto = total / (1 + IVA)
  const neto = parseFloat((totalConIva / (1 + IVA_RATE)).toFixed(2))
  const iva  = parseFloat((totalConIva - neto).toFixed(2))
  // Ajuste de redondeo para que siempre sume exacto
  const ivaAjustado = parseFloat((totalConIva - neto).toFixed(2))
  return { neto, iva: ivaAjustado }
}

function today(): number {
  const d = new Date()
  const offset = d.getTimezoneOffset() * 60000
  return parseInt(
    new Date(d.getTime() - offset).toISOString().split('T')[0].replace(/-/g, '')
  )
}

// ─── Función principal ────────────────────────────────────────────────────────

export async function emitirFacturaPedido(
  config: RestauranteAfipConfig,
  pedido: PedidoParaFacturar
): Promise<ResultadoFactura> {

  // 1. Crear instancia con el certificado del restaurante
  const afip = new Afip({
    CUIT: Number(config.cuit),
    cert: config.cert,
    key: config.key,
    access_token: process.env.AFIPSDK_ACCESS_TOKEN!,
    production: false, // Cambiar a false para testing
  })

  // 2. Resolver punto de venta: usar el existente o crear uno nuevo
  let puntoDeVenta: number

  if (config.puntoDeVenta) {
    puntoDeVenta = config.puntoDeVenta
  } else {
    // Crear punto de venta via automatización AfipSDK
    // Esto usa la clave fiscal del restaurante → AfipSDK lo hace en ARCA automáticamente
    puntoDeVenta = await crearPuntoDeVenta(afip, config)
  }

  // 3. Calcular importes
  const { neto, iva } = calcularImportes(pedido.total)

  // 4. Obtener próximo número de comprobante y emitir
  const data = {
    CantReg: 1,
    PtoVta: puntoDeVenta,
    CbteTipo: TIPO_COMPROBANTE,
    Concepto: CONCEPTO,
    DocTipo: DOC_TIPO,
    DocNro: DOC_NRO,
    CbteDesde: 0,   // createNextVoucher lo resuelve automáticamente
    CbteHasta: 0,
    CbteFch: today(),
    ImpTotal: pedido.total,
    ImpTotConc: 0,
    ImpNeto: neto,
    ImpOpEx: 0,
    ImpIVA: iva,
    ImpTrib: 0,
    MonId: 'PES',
    MonCotiz: 1,
    CondicionIVAReceptorId: CONDICION_IVA,
    Iva: [
      {
        Id: IVA_ALICUOTA_ID,
        BaseImp: neto,
        Importe: iva,
      },
    ],
  }

  // createNextVoucher obtiene el último número, le suma 1, y emite
  const res = await afip.ElectronicBilling.createNextVoucher(data)

  console.log('AFIP res raw:', JSON.stringify(res))

  return {
    cae: res.CAE,
    caeFchVto: res.CAEFchVto,
    puntoDeVenta,
    numeroComprobante: res.voucher_number,
  }
}

// ─── Crear punto de venta via automatización ──────────────────────────────────

async function crearPuntoDeVenta(
  afip: InstanceType<typeof Afip>,
  config: RestauranteAfipConfig
): Promise<number> {

  // Primero listar los puntos de venta existentes para no duplicar
  // y para elegir el próximo número disponible
  let puntosExistentes: number[] = []

  try {
    const listResponse = await afip.CreateAutomation(
      'list-sales-points',
      {
        cuit: config.cuit,
        username: config.cuit,   // En ARCA, username = CUIT propio
        password: config.claveFiscal,
      },
      true // wait = true → espera a que termine
    )

    // La respuesta tiene los puntos de venta existentes
    if (Array.isArray(listResponse)) {
      puntosExistentes = listResponse.map((p: any) => Number(p.numero || p.Nro || p.nro))
    }
  } catch {
    // Si falla el listado, asumimos que no hay ninguno
  }

  // Elegir el próximo número disponible (el menor entero positivo no usado)
  let numeroPuntoDeVenta = 1
  while (puntosExistentes.includes(numeroPuntoDeVenta)) {
    numeroPuntoDeVenta++
  }

  // Crear el punto de venta
  // sistema: 'FEEWS' = Factura Electrónica Web Service (para responsable inscripto)
  // sistema: 'FEEM'  = Factura Electrónica Monotributo
  // Ajustar según la condición del restaurante. Por defecto responsable inscripto.
  await afip.CreateAutomation(
    'create-sales-point',
    {
      cuit: config.cuit,
      username: config.cuit,
      password: config.claveFiscal,
      numero: numeroPuntoDeVenta,
      sistema: 'FEEWS',
      nombreFantasia: config.nombreFantasia,
    },
    true
  )

  return numeroPuntoDeVenta
}