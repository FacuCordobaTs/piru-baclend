import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import QRCode from 'qrcode'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, '')

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID!,
    secretAccessKey: R2_SECRET_ACCESS_KEY!,
  },
})

export interface DatosFacturaPdf {
  puntoDeVenta: number
  numeroComprobante: number
  cae: string
  caeFchVto: string
  fechaEmision: string
  total: number
  neto: number
  iva: number
  emisorCuit: string
  emisorNombre: string
  emisorDireccion: string | null
  emisorCondicionIva: 'RI' | 'MO'
  receptorNombre: string
  items: Array<{
    descripcion: string
    cantidad: number
    precioUnitario: number
    subtotal: number
  }>
  restauranteId: number
  pedidoId: number
}

export interface ResultadoPdfFactura {
  url: string
}

function formatCuit(cuit: string): string {
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`
}

function formatNroComprobante(pv: number, n: number): string {
  return `${String(pv).padStart(4, '0')}-${String(n).padStart(8, '0')}`
}

function formatFecha(fecha: string): string {
  const [y, m, d] = fecha.split('-')
  return `${d}/${m}/${y}`
}

function formatImporte(n: number): string {
  return '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export async function generarYSubirPdfFactura(datos: DatosFacturaPdf): Promise<ResultadoPdfFactura> {
  // 1. Generar QR de ARCA
  const qrData = {
    ver: 1,
    fecha: datos.fechaEmision,
    cuit: Number(datos.emisorCuit),
    ptoVta: datos.puntoDeVenta,
    tipoCmp: 6,
    nroCmp: datos.numeroComprobante,
    importe: datos.total,
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: 99,
    nroDocRec: 0,
    tipoCodAut: 'E',
    codAut: Number(datos.cae),
  }
  const base64 = Buffer.from(JSON.stringify(qrData)).toString('base64url')
  const qrUrl = `https://www.afip.gob.ar/fe/qr/?p=${base64}`
  const qrBuffer = await QRCode.toBuffer(qrUrl, { type: 'png', width: 120, margin: 1 })

  // 2. Generar PDF
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([595, 842]) // A4
  const { width, height } = page.getSize()

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const black = rgb(0, 0, 0)
  const gray = rgb(0.4, 0.4, 0.4)
  const lightGray = rgb(0.9, 0.9, 0.9)
  const margin = 40

  let y = height - margin

  // ── Encabezado ───────────────────────────────────────────────────────────────

  // Nombre del restaurante (izquierda)
  page.drawText(datos.emisorNombre, {
    x: margin,
    y,
    size: 16,
    font: fontBold,
    color: black,
  })
  y -= 18

  if (datos.emisorDireccion) {
    page.drawText(datos.emisorDireccion, {
      x: margin,
      y,
      size: 9,
      font: fontRegular,
      color: gray,
    })
    y -= 13
  }

  page.drawText(`CUIT: ${formatCuit(datos.emisorCuit)}`, {
    x: margin,
    y,
    size: 9,
    font: fontRegular,
    color: gray,
  })
  y -= 13

  const condicionTexto = datos.emisorCondicionIva === 'RI' ? 'Responsable Inscripto' : 'Monotributista'
  page.drawText(`IVA: ${condicionTexto}`, {
    x: margin,
    y,
    size: 9,
    font: fontRegular,
    color: gray,
  })

  // Recuadro letra "B" (centro)
  const letraBoxSize = 60
  const letraBoxX = (width - letraBoxSize) / 2
  const letraBoxY = height - margin - letraBoxSize
  page.drawRectangle({
    x: letraBoxX,
    y: letraBoxY,
    width: letraBoxSize,
    height: letraBoxSize,
    borderColor: black,
    borderWidth: 2,
    color: rgb(1, 1, 1),
  })
  const letraLetra = datos.emisorCondicionIva === 'MO' ? 'C' : 'B'
  page.drawText(letraLetra, {
    x: letraBoxX + 18,
    y: letraBoxY + 12,
    size: 38,
    font: fontBold,
    color: black,
  })
  page.drawText('Cod. 06', {
    x: letraBoxX + 6,
    y: letraBoxY + 3,
    size: 6,
    font: fontRegular,
    color: gray,
  })

  // Datos derecha
  const rightX = width - margin - 160
  const headerTopY = height - margin
  page.drawText('FACTURA', {
    x: rightX,
    y: headerTopY,
    size: 14,
    font: fontBold,
    color: black,
  })
  page.drawText(`Nº ${formatNroComprobante(datos.puntoDeVenta, datos.numeroComprobante)}`, {
    x: rightX,
    y: headerTopY - 18,
    size: 9,
    font: fontRegular,
    color: black,
  })
  page.drawText(`Fecha: ${formatFecha(datos.fechaEmision)}`, {
    x: rightX,
    y: headerTopY - 32,
    size: 9,
    font: fontRegular,
    color: black,
  })

  // Línea separadora
  y = height - margin - letraBoxSize - 14
  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 1,
    color: lightGray,
  })
  y -= 16

  // ── Receptor ─────────────────────────────────────────────────────────────────

  page.drawText(`Señor(es): ${datos.receptorNombre}`, {
    x: margin,
    y,
    size: 9,
    font: fontRegular,
    color: black,
  })
  y -= 13
  page.drawText('Condición IVA: Consumidor Final', {
    x: margin,
    y,
    size: 9,
    font: fontRegular,
    color: black,
  })
  y -= 18

  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 1,
    color: lightGray,
  })
  y -= 16

  // ── Tabla de items ────────────────────────────────────────────────────────────

  const colDesc = margin
  const colCant = margin + 280
  const colUnit = margin + 340
  const colSub = width - margin - 70

  // Cabecera tabla
  page.drawRectangle({
    x: margin,
    y: y - 4,
    width: width - margin * 2,
    height: 16,
    color: lightGray,
  })
  page.drawText('Descripción', { x: colDesc, y, size: 8, font: fontBold, color: black })
  page.drawText('Cant.', { x: colCant, y, size: 8, font: fontBold, color: black })
  page.drawText('Precio Unit.', { x: colUnit, y, size: 8, font: fontBold, color: black })
  page.drawText('Subtotal', { x: colSub, y, size: 8, font: fontBold, color: black })
  y -= 20

  // Filas
  for (const item of datos.items) {
    const desc = item.descripcion.length > 45 ? item.descripcion.slice(0, 44) + '…' : item.descripcion
    page.drawText(desc, { x: colDesc, y, size: 8, font: fontRegular, color: black })
    page.drawText(String(item.cantidad), { x: colCant, y, size: 8, font: fontRegular, color: black })
    page.drawText(formatImporte(item.precioUnitario), { x: colUnit, y, size: 8, font: fontRegular, color: black })
    page.drawText(formatImporte(item.subtotal), { x: colSub, y, size: 8, font: fontRegular, color: black })
    y -= 14
  }

  y -= 6
  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 1,
    color: lightGray,
  })
  y -= 16

  // ── Totales ───────────────────────────────────────────────────────────────────

  const totalesX = width - margin - 180
  const totalesValX = width - margin - 70

  page.drawText('Neto Gravado:', { x: totalesX, y, size: 9, font: fontRegular, color: black })
  page.drawText(formatImporte(datos.neto), { x: totalesValX, y, size: 9, font: fontRegular, color: black })
  y -= 14

  page.drawText('IVA 21%:', { x: totalesX, y, size: 9, font: fontRegular, color: black })
  page.drawText(formatImporte(datos.iva), { x: totalesValX, y, size: 9, font: fontRegular, color: black })
  y -= 14

  page.drawLine({
    start: { x: totalesX, y: y + 2 },
    end: { x: width - margin, y: y + 2 },
    thickness: 1,
    color: gray,
  })
  y -= 6

  page.drawText('TOTAL:', { x: totalesX, y, size: 11, font: fontBold, color: black })
  page.drawText(formatImporte(datos.total), { x: totalesValX, y, size: 11, font: fontBold, color: black })

  // ── Pie (CAE + QR) ────────────────────────────────────────────────────────────

  const footerY = 90
  page.drawLine({
    start: { x: margin, y: footerY + 60 },
    end: { x: width - margin, y: footerY + 60 },
    thickness: 1,
    color: lightGray,
  })

  page.drawText(`CAE: ${datos.cae}`, {
    x: margin,
    y: footerY + 44,
    size: 8,
    font: fontRegular,
    color: black,
  })
  page.drawText(`Fecha Vto. CAE: ${formatFecha(datos.caeFchVto)}`, {
    x: margin,
    y: footerY + 30,
    size: 8,
    font: fontRegular,
    color: black,
  })
  page.drawText('Comprobante autorizado por ARCA', {
    x: margin,
    y: footerY + 16,
    size: 7,
    font: fontRegular,
    color: gray,
  })

  // QR embebido
  const qrImage = await pdfDoc.embedPng(qrBuffer)
  const qrSize = 80
  page.drawImage(qrImage, {
    x: width - margin - qrSize,
    y: footerY,
    width: qrSize,
    height: qrSize,
  })

  // 3. Serializar y subir a R2
  const pdfBytes = await pdfDoc.save()
  const key = `facturas/${datos.restauranteId}/${datos.pedidoId}.pdf`

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: pdfBytes,
    ContentType: 'application/pdf',
  })

  await s3Client.send(command)

  return { url: `${R2_PUBLIC_URL}/${key}` }
}
