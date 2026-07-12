import { Hono } from 'hono'
import { randomUUID, randomInt } from 'crypto'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { setCookie } from 'hono/cookie'
import { restaurante, registroTelefono } from '../db/schema'
import { and, eq, gt } from 'drizzle-orm'
import { createAccessToken } from '../libs/jwt'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import * as bcrypt from 'bcrypt'
import { authMiddleware } from '../middleware/auth'
import { sendVerificationCodeWhatsApp } from '../services/whatsapp'

const signUpRestauranteSchema = z.object({
  email: z.string().email().min(3),
  password: z.string().min(3),
  nombre: z.string().min(3),
});

// ---- Registro por WhatsApp (self-serve) ----
const OTP_EXPIRACION_MS = 10 * 60 * 1000 // el código vive 10 minutos
const OTP_REENVIO_COOLDOWN_MS = 45 * 1000 // no permitir reenviar antes de 45s
const OTP_MAX_INTENTOS = 5 // intentos fallidos antes de invalidar la sesión

// Normaliza a solo dígitos (formato internacional que espera la API de WhatsApp, ej: 5493511234567)
const normalizarTelefono = (raw: string): string => raw.replace(/\D/g, '')

const generarCodigo = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0')

const startTelefonoSchema = z.object({
  telefono: z.string().min(8).max(20),
})

const verifyTelefonoSchema = z.object({
  verificationId: z.string().uuid(),
  codigo: z.string().regex(/^\d{6}$/),
})

const resendTelefonoSchema = z.object({
  verificationId: z.string().uuid(),
})

// const signUpUsuarioAdminSchema = z.object({
//   email: z.string().email().min(3),
//   password: z.string().min(3),
//   name: z.string().min(3),
//   restaurantePassword: z.string().min(3),
//   restauranteEmail: z.string().email().min(3),
// });

const loginRestauranteSchema = z.object({
  email: z.string().email().min(3),
  password: z.string().min(3),
});

// const loginUsuarioAdminSchema = z.object({
//   email: z.string().email().min(3),
//   password: z.string().min(3),
// });


export const authRoute = new Hono()
.options('/beta-signup', async (c) => {
  return c.text('', 200)
})


.post('/register-restaurante', zValidator("json", signUpRestauranteSchema), async (c) => {
  const { email, nombre, password } = c.req.valid("json");
  const db = drizzle(pool);

  try {
      const existingEmail = await db.select().from(restaurante)
          .where(eq(restaurante.email, email));

      if (existingEmail.length) {
          return c.json({ error: 'Email ya utilizado', existingEmail }, 409);
      }

      const passwordHash = await bcrypt.hash(password, 10);
      await db.insert(restaurante).values({
          email,
          nombre,
          password: passwordHash,
          createdAt: new Date()
      });

      const newRestaurante = await db.select().from(restaurante)
          .where(eq(restaurante.email, email))
          .limit(1);

      const token = await createAccessToken({ id: newRestaurante[0].id });
      setCookie(c, 'token', token as string, {
          path: '/',
          sameSite: 'None',
          secure: true,
          maxAge: 365 * 24 * 60 * 60,
      });

      return c.json({ message: 'Restaurante registrado correctamente', newRestaurante, token }, 200);
  } catch (error: any) {
      return c.json({ message: 'Error al registrar el usuario'}, 400);
  }
})
.post('/login-restaurante', zValidator("json", loginRestauranteSchema), async (c) => {
  const { email, password } = c.req.valid("json");
  const db = drizzle(pool);

  try {
      const restauranteResult = await db.select().from(restaurante)
          .where(eq(restaurante.email, email));

      if (!restauranteResult.length) {
          return c.json({ message: 'Usuario no encontrado' }, 400);
      }

      if (!restauranteResult[0].password) {
          return c.json({ message: 'Contraseña no válida' }, 400);
      }
      const isMatch = await bcrypt.compare(password, restauranteResult[0].password);
      if (!isMatch) {
          return c.json({ message: 'Contraseña incorrecta' }, 400);
      }

      const token = await createAccessToken({ id: restauranteResult[0].id });
      setCookie(c, 'token', token as string, {
          path: '/',
          sameSite: 'None',
          secure: true,
          maxAge: 365 * 24 * 60 * 60,
      });

      return c.json({ message: 'Inicio de sesión realizado con éxito', restaurante: restauranteResult[0], token }, 200);
  } catch (error) {
      return c.json({ error: 'Login failed' }, 500);
  }
})

// 1) Iniciar registro por WhatsApp: genera un código, lo envía y devuelve un verificationId único.
authRoute.post('/register-telefono/start', zValidator('json', startTelefonoSchema), async (c) => {
  const db = drizzle(pool)
  const telefono = normalizarTelefono(c.req.valid('json').telefono)

  if (telefono.length < 8) {
    return c.json({ message: 'El número de celular no es válido', success: false }, 400)
  }

  try {
    // Si ya existe una cuenta verificada con ese número, no dejamos volver a registrar.
    const cuentaExistente = await db.select({ id: restaurante.id })
      .from(restaurante)
      .where(and(eq(restaurante.telefono, telefono), eq(restaurante.telefonoVerificado, true)))
      .limit(1)

    if (cuentaExistente.length) {
      return c.json({ message: 'Ya existe una cuenta registrada con este número de WhatsApp', success: false }, 409)
    }

    // Anti-spam: no permitir generar otro código para el mismo número dentro del cooldown.
    const desde = new Date(Date.now() - OTP_REENVIO_COOLDOWN_MS)
    const reciente = await db.select({ id: registroTelefono.id })
      .from(registroTelefono)
      .where(and(
        eq(registroTelefono.telefono, telefono),
        eq(registroTelefono.verificado, false),
        gt(registroTelefono.createdAt, desde),
      ))
      .limit(1)

    if (reciente.length) {
      return c.json({ message: 'Ya te enviamos un código hace unos segundos. Esperá un momento antes de pedir otro.', success: false }, 429)
    }

    const codigo = generarCodigo()
    const codigoHash = await bcrypt.hash(codigo, 10)
    const verificationId = randomUUID()
    const expiraEn = new Date(Date.now() + OTP_EXPIRACION_MS)

    await db.insert(registroTelefono).values({
      id: verificationId,
      telefono,
      codigoHash,
      expiraEn,
    })

    const envio = await sendVerificationCodeWhatsApp(c, { phone: telefono, code: codigo })
    if (!envio.success) {
      // Limpiamos la sesión inservible para no dejar basura ni bloquear reintentos.
      await db.delete(registroTelefono).where(eq(registroTelefono.id, verificationId))
      return c.json({ message: 'No pudimos enviar el código por WhatsApp. Revisá el número e intentá de nuevo.', success: false }, 502)
    }

    return c.json({
      message: 'Código enviado por WhatsApp',
      success: true,
      verificationId,
      telefono,
      expiraEnSegundos: Math.floor(OTP_EXPIRACION_MS / 1000),
    }, 200)
  } catch (error) {
    console.error('Error iniciando registro por teléfono:', error)
    return c.json({ message: 'Error al iniciar el registro', success: false }, 500)
  }
})

// 2) Reenviar el código para una sesión existente (mismo verificationId).
authRoute.post('/register-telefono/resend', zValidator('json', resendTelefonoSchema), async (c) => {
  const db = drizzle(pool)
  const { verificationId } = c.req.valid('json')

  try {
    const [reg] = await db.select().from(registroTelefono)
      .where(eq(registroTelefono.id, verificationId))
      .limit(1)

    if (!reg) {
      return c.json({ message: 'Sesión de verificación no encontrada', success: false }, 404)
    }
    if (reg.verificado) {
      return c.json({ message: 'Esta verificación ya fue completada', success: false }, 400)
    }

    // Cooldown de reenvío basado en la última actualización de la sesión.
    if (reg.createdAt && Date.now() - new Date(reg.createdAt).getTime() < OTP_REENVIO_COOLDOWN_MS) {
      return c.json({ message: 'Esperá unos segundos antes de pedir otro código', success: false }, 429)
    }

    const codigo = generarCodigo()
    const codigoHash = await bcrypt.hash(codigo, 10)

    await db.update(registroTelefono)
      .set({
        codigoHash,
        intentos: 0,
        createdAt: new Date(),
        expiraEn: new Date(Date.now() + OTP_EXPIRACION_MS),
      })
      .where(eq(registroTelefono.id, verificationId))

    const envio = await sendVerificationCodeWhatsApp(c, { phone: reg.telefono, code: codigo })
    if (!envio.success) {
      return c.json({ message: 'No pudimos reenviar el código por WhatsApp', success: false }, 502)
    }

    return c.json({ message: 'Código reenviado por WhatsApp', success: true }, 200)
  } catch (error) {
    console.error('Error reenviando código:', error)
    return c.json({ message: 'Error al reenviar el código', success: false }, 500)
  }
})

// 3) Verificar el código y crear la cuenta.
authRoute.post('/register-telefono/verify', zValidator('json', verifyTelefonoSchema), async (c) => {
  const db = drizzle(pool)
  const { verificationId, codigo } = c.req.valid('json')

  try {
    const [reg] = await db.select().from(registroTelefono)
      .where(eq(registroTelefono.id, verificationId))
      .limit(1)

    if (!reg) {
      return c.json({ message: 'Sesión de verificación no encontrada', success: false }, 404)
    }
    if (reg.verificado) {
      return c.json({ message: 'Esta verificación ya fue completada', success: false }, 400)
    }
    if (new Date(reg.expiraEn).getTime() < Date.now()) {
      return c.json({ message: 'El código expiró. Pedí uno nuevo.', success: false }, 400)
    }
    if (reg.intentos >= OTP_MAX_INTENTOS) {
      return c.json({ message: 'Demasiados intentos fallidos. Pedí un código nuevo.', success: false }, 429)
    }

    const codigoOk = await bcrypt.compare(codigo, reg.codigoHash)
    if (!codigoOk) {
      await db.update(registroTelefono)
        .set({ intentos: reg.intentos + 1 })
        .where(eq(registroTelefono.id, verificationId))
      const restantes = OTP_MAX_INTENTOS - (reg.intentos + 1)
      return c.json({
        message: restantes > 0 ? `Código incorrecto. Te quedan ${restantes} intentos.` : 'Código incorrecto. Pedí un código nuevo.',
        success: false,
      }, 400)
    }

    // Revalidar unicidad por si otra sesión creó la cuenta mientras tanto.
    const cuentaExistente = await db.select({ id: restaurante.id })
      .from(restaurante)
      .where(and(eq(restaurante.telefono, reg.telefono), eq(restaurante.telefonoVerificado, true)))
      .limit(1)

    if (cuentaExistente.length) {
      await db.update(registroTelefono)
        .set({ verificado: true, restauranteId: cuentaExistente[0].id })
        .where(eq(registroTelefono.id, verificationId))
      return c.json({ message: 'Ya existe una cuenta registrada con este número de WhatsApp', success: false }, 409)
    }

    // La cuenta se crea sólo con el teléfono verificado; el nombre y demás datos
    // se completan luego en el onboarding.
    await db.insert(restaurante).values({
      telefono: reg.telefono,
      telefonoVerificado: true,
      createdAt: new Date(),
    })

    const [newRestauranteRow] = await db.select().from(restaurante)
      .where(and(eq(restaurante.telefono, reg.telefono), eq(restaurante.telefonoVerificado, true)))
      .limit(1)

    await db.update(registroTelefono)
      .set({ verificado: true, restauranteId: newRestauranteRow.id })
      .where(eq(registroTelefono.id, verificationId))

    const token = await createAccessToken({ id: newRestauranteRow.id })
    setCookie(c, 'token', token as string, {
      path: '/',
      sameSite: 'None',
      secure: true,
      maxAge: 365 * 24 * 60 * 60,
    })

    // Devolvemos newRestaurante como array para mantener compatibilidad con el frontend de email.
    return c.json({
      message: '¡Número verificado! Bienvenido a Piru',
      success: true,
      newRestaurante: [newRestauranteRow],
      token,
    }, 200)
  } catch (error) {
    console.error('Error verificando código:', error)
    return c.json({ message: 'Error al verificar el código', success: false }, 500)
  }
})

// ─────────────────────────────────────────────────────────────
// Login por WhatsApp (para cuentas registradas con celular, que no tienen contraseña).
// Mismo mecanismo de OTP que el registro, pero exige que la cuenta YA exista y no crea nada.
// El reenvío usa el endpoint genérico /register-telefono/resend (opera sólo por verificationId).
// ─────────────────────────────────────────────────────────────

// 1) Iniciar login por WhatsApp: valida que exista la cuenta, envía el código y devuelve el verificationId.
authRoute.post('/login-telefono/start', zValidator('json', startTelefonoSchema), async (c) => {
  const db = drizzle(pool)
  const telefono = normalizarTelefono(c.req.valid('json').telefono)

  if (telefono.length < 8) {
    return c.json({ message: 'El número de celular no es válido', success: false }, 400)
  }

  try {
    // Debe existir una cuenta verificada con ese número; si no, no hay nada a lo que entrar.
    const [cuenta] = await db.select({ id: restaurante.id })
      .from(restaurante)
      .where(and(eq(restaurante.telefono, telefono), eq(restaurante.telefonoVerificado, true)))
      .limit(1)

    if (!cuenta) {
      return c.json({ message: 'No encontramos ninguna cuenta con este número de WhatsApp', success: false }, 404)
    }

    // Anti-spam: no permitir generar otro código para el mismo número dentro del cooldown.
    const desde = new Date(Date.now() - OTP_REENVIO_COOLDOWN_MS)
    const reciente = await db.select({ id: registroTelefono.id })
      .from(registroTelefono)
      .where(and(
        eq(registroTelefono.telefono, telefono),
        eq(registroTelefono.verificado, false),
        gt(registroTelefono.createdAt, desde),
      ))
      .limit(1)

    if (reciente.length) {
      return c.json({ message: 'Ya te enviamos un código hace unos segundos. Esperá un momento antes de pedir otro.', success: false }, 429)
    }

    const codigo = generarCodigo()
    const codigoHash = await bcrypt.hash(codigo, 10)
    const verificationId = randomUUID()
    const expiraEn = new Date(Date.now() + OTP_EXPIRACION_MS)

    await db.insert(registroTelefono).values({
      id: verificationId,
      telefono,
      codigoHash,
      expiraEn,
      restauranteId: cuenta.id,
    })

    const envio = await sendVerificationCodeWhatsApp(c, { phone: telefono, code: codigo })
    if (!envio.success) {
      await db.delete(registroTelefono).where(eq(registroTelefono.id, verificationId))
      return c.json({ message: 'No pudimos enviar el código por WhatsApp. Intentá de nuevo.', success: false }, 502)
    }

    return c.json({
      message: 'Código enviado por WhatsApp',
      success: true,
      verificationId,
      telefono,
      expiraEnSegundos: Math.floor(OTP_EXPIRACION_MS / 1000),
    }, 200)
  } catch (error) {
    console.error('Error iniciando login por teléfono:', error)
    return c.json({ message: 'Error al iniciar sesión', success: false }, 500)
  }
})

// 2) Verificar el código y devolver el token de la cuenta existente (no crea cuentas).
authRoute.post('/login-telefono/verify', zValidator('json', verifyTelefonoSchema), async (c) => {
  const db = drizzle(pool)
  const { verificationId, codigo } = c.req.valid('json')

  try {
    const [reg] = await db.select().from(registroTelefono)
      .where(eq(registroTelefono.id, verificationId))
      .limit(1)

    if (!reg) {
      return c.json({ message: 'Sesión de verificación no encontrada', success: false }, 404)
    }
    if (reg.verificado) {
      return c.json({ message: 'Esta verificación ya fue completada', success: false }, 400)
    }
    if (new Date(reg.expiraEn).getTime() < Date.now()) {
      return c.json({ message: 'El código expiró. Pedí uno nuevo.', success: false }, 400)
    }
    if (reg.intentos >= OTP_MAX_INTENTOS) {
      return c.json({ message: 'Demasiados intentos fallidos. Pedí un código nuevo.', success: false }, 429)
    }

    const codigoOk = await bcrypt.compare(codigo, reg.codigoHash)
    if (!codigoOk) {
      await db.update(registroTelefono)
        .set({ intentos: reg.intentos + 1 })
        .where(eq(registroTelefono.id, verificationId))
      const restantes = OTP_MAX_INTENTOS - (reg.intentos + 1)
      return c.json({
        message: restantes > 0 ? `Código incorrecto. Te quedan ${restantes} intentos.` : 'Código incorrecto. Pedí un código nuevo.',
        success: false,
      }, 400)
    }

    // Buscar la cuenta verificada asociada al número.
    const [cuenta] = await db.select().from(restaurante)
      .where(and(eq(restaurante.telefono, reg.telefono), eq(restaurante.telefonoVerificado, true)))
      .limit(1)

    if (!cuenta) {
      return c.json({ message: 'No encontramos ninguna cuenta con este número de WhatsApp', success: false }, 404)
    }

    await db.update(registroTelefono)
      .set({ verificado: true, restauranteId: cuenta.id })
      .where(eq(registroTelefono.id, verificationId))

    const token = await createAccessToken({ id: cuenta.id })
    setCookie(c, 'token', token as string, {
      path: '/',
      sameSite: 'None',
      secure: true,
      maxAge: 365 * 24 * 60 * 60,
    })

    return c.json({
      message: 'Sesión iniciada correctamente',
      success: true,
      restaurante: cuenta,
      token,
    }, 200)
  } catch (error) {
    console.error('Error verificando login por teléfono:', error)
    return c.json({ message: 'Error al verificar el código', success: false }, 500)
  }
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
})

authRoute.put('/change-password', authMiddleware, zValidator('json', changePasswordSchema), async (c) => {
  const { currentPassword, newPassword } = c.req.valid('json')
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    const [rest] = await db.select({ password: restaurante.password })
      .from(restaurante)
      .where(eq(restaurante.id, restauranteId))
      .limit(1)

    if (!rest?.password) {
      return c.json({ message: 'Error al verificar la contraseña', success: false }, 400)
    }

    const isMatch = await bcrypt.compare(currentPassword, rest.password)
    if (!isMatch) {
      return c.json({ message: 'La contraseña actual es incorrecta', success: false }, 400)
    }

    const newHash = await bcrypt.hash(newPassword, 10)
    await db.update(restaurante).set({ password: newHash }).where(eq(restaurante.id, restauranteId))

    return c.json({ message: 'Contraseña actualizada correctamente', success: true }, 200)
  } catch (error) {
    console.error('Error changing password:', error)
    return c.json({ message: 'Error al cambiar contraseña', success: false }, 500)
  }
})

// .post('/login-usuario-admin', zValidator("json", loginUsuarioAdminSchema), async (c) => {
//   const { email, password } = c.req.valid("json");
//   const db = drizzle(pool);

//   try {
//       const usuarioAdminResult = await db.select().from(UsuarioAdminTable)
//           .where(eq(UsuarioAdminTable.email, email));

//       if (!usuarioAdminResult.length) {
//           return c.json({ message: 'Usuario admin no encontrado' }, 400);
//       }

//       if (!usuarioAdminResult[0].password) {
//           return c.json({ message: 'Contraseña no válida' }, 400);
//       }

//       const isMatch = await bcrypt.compare(password, usuarioAdminResult[0].password);
//       if (!isMatch) {
//           return c.json({ message: 'Contraseña incorrecta' }, 400);
//       }

//       const token = await createAccessToken({ id: usuarioAdminResult[0].id });
//       setCookie(c, 'token', token as string, {
//           path: '/',
//           sameSite: 'None',
//           secure: true,
//           maxAge: 7 * 24 * 60 * 60,
//       });

//       return c.json({ message: 'Inicio de sesión realizado con éxito', usuarioAdmin: usuarioAdminResult[0], token }, 200);
//   } catch (error) {
//       return c.json({ error: 'Login failed' }, 500);
//   }
// })

// .post('/register-usuario-admin', zValidator("json", signUpUsuarioAdminSchema), async (c) => {
//   const { email, name, password  } = c.req.valid("json");
//   const db = drizzle(pool);

//   try {
//       const existingEmail = await db.select().from(UsuarioAdminTable)
//           .where(eq(UsuarioAdminTable.email, email));

//       if (existingEmail.length) {
//           return c.json({ error: 'Email ya utilizado', existingEmail }, 409);
//       }


//       const restauranteResult = await db.select().from(restaurante)
//           .where(eq(restaurante.email, restauranteEmail));

//       if (!restauranteResult.length) {
//           return c.json({ message: 'Restaurante no encontrado' }, 400);
//       }

//       if (!restauranteResult[0].password) {
//           return c.json({ message: 'Contraseña no válida' }, 400);
//       }

//       const isMatch = await bcrypt.compare(restaurantePassword, restauranteResult[0].password);
//       if (!isMatch) {
//           return c.json({ message: 'Contraseña incorrecta' }, 400);
//       }

//       const passwordHash = await bcrypt.hash(password, 10);
//       await db.insert(UsuarioAdminTable).values({
//           email,
//           name,
//           password: passwordHash,
//           createdAt: new Date(),
//           restauranteId: restauranteResult[0].id
//       });

//       const newUsuarioAdmin = await db.select().from(UsuarioAdminTable)
//           .where(eq(UsuarioAdminTable.email, email))
//           .limit(1);

//       const token = await createAccessToken({ id: newUsuarioAdmin[0].id });
//       setCookie(c, 'token', token as string, {
//           path: '/',
//           sameSite: 'None',
//           secure: true,
//           maxAge: 7 * 24 * 60 * 60,
//       });

//       return c.json({ message: 'Usuario admin registrado correctamente', newUsuarioAdmin, token }, 200);
//   } catch (error) {
//       return c.json({ error: 'Registro de usuario admin falló' }, 400);
//   }
// })

