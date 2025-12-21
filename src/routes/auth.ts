import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { setCookie } from 'hono/cookie'
import { restaurante } from '../db/schema'
import { eq } from 'drizzle-orm'
import { createAccessToken } from '../libs/jwt'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import * as bcrypt from 'bcrypt'

const signUpRestauranteSchema = z.object({
  email: z.string().email().min(3),
  password: z.string().min(3),
  nombre: z.string().min(3),
});

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
          maxAge: 7 * 24 * 60 * 60,
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
          maxAge: 7 * 24 * 60 * 60,
      });

      return c.json({ message: 'Inicio de sesión realizado con éxito', restaurante: restauranteResult[0], token }, 200);
  } catch (error) {
      return c.json({ error: 'Login failed' }, 500);
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

