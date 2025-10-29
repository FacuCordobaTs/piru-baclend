import { Hono } from 'hono'
import { OAuth2Client } from 'google-auth-library'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { setCookie, deleteCookie } from 'hono/cookie'
import { user as UserTable } from '../db/schema'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'crypto'
import * as jwt from 'jsonwebtoken'

const createAccessToken = (payload: { id: number }) => {
  return jwt.sign(payload, process.env.JWT_SECRET || 'fallback-secret', { 
    expiresIn: '7d' 
  });
}

// Helper function to extract token from request (for API endpoints)
export const extractToken = (c: any) => {
  const authHeader = c.req.header('Authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7)
  }
  return null
}

// OAuth2Client should use the backend callback URL, not the client redirect URI
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID!,
  process.env.GOOGLE_CLIENT_SECRET!,
  `${process.env.API_BASE_URL || 'https://api.piru.app/api'}/auth/google/callback`
)

export const authRoute = new Hono()
.options('/beta-signup', async (c) => {
  return c.text('', 200)
})
.get('/google', async (c) => {
  const state = randomBytes(16).toString('hex');
  const redirectUri = c.req.query('redirect_uri') || 'piru://';

  const stateObj = { state, redirectUri };
  const stateParam = Buffer.from(JSON.stringify(stateObj)).toString('base64');
  setCookie(c, 'oauth_state', state, {
    path: '/api/auth/google/callback',
    httpOnly: true,
    maxAge: 600,
    sameSite: 'None',
    // secure: process.env.NODE_ENV === 'production',
    secure: true,
});

  const authUrl = googleClient.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email', 
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    state: stateParam,
  })

  return c.redirect(authUrl)
})

.get('/google/callback', async (c) => {
  const db = drizzle(pool)
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  
  deleteCookie(c, 'oauth_state', { path: '/api/auth/google/callback' });

  // Decodifica el parámetro state
  let redirectUri = 'https://piru.app';
  try {
    if (stateParam) {
      const stateObj = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf-8'));
      console.log('Decoded stateObj:', stateObj);
      if (stateObj.redirectUri) {
        redirectUri = stateObj.redirectUri;
      }
    }
  } catch (e) {
    console.error('Error decoding state:', e);
    redirectUri = 'https://piru.app';
  }

  if (!code) {
      const error = c.req.query('error');
      console.error('Google OAuth Error (no code):', error);
      return c.redirect(`${redirectUri}?error=${error || 'unknown_google_error'}`);
  }

  try {
      console.log('Getting Google tokens...');
      const { tokens } = await googleClient.getToken(code);
      console.log('Google tokens:', tokens);
      googleClient.setCredentials(tokens); 
      
      if (!tokens.id_token) {
          console.error('No ID token received from Google.');
          throw new Error("ID token not received from Google.");
      }
      console.log('Verifying ID token...');
      const loginTicket = await googleClient.verifyIdToken({
          idToken: tokens.id_token,
          audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = loginTicket.getPayload();
      console.log('Google payload:', payload);
      if (!payload || !payload.sub || !payload.email) {
          console.error('Invalid Google profile payload.');
          throw new Error('Información de perfil de Google inválida.');
      }

      const googleId = payload.sub;
      const email = payload.email;

      let user = null;
      const existingUser = await db.select().from(UserTable)
          .where(eq(UserTable.email, email))
          .limit(1);
      console.log('Existing user:', existingUser);

      if (existingUser.length) {
          user = existingUser[0];
          if (!user.googleId) {
              await db.update(UserTable)
              .set({ googleId: googleId }) 
              .where(eq(UserTable.id, user.id));
              user.googleId = googleId; 
          } else if (user.googleId !== googleId) {
              console.error('Email/GoogleID conflict.');
              return c.redirect(`${redirectUri}?error=email_google_conflict`);
          }
      } else {
          const insertResult = await db.insert(UserTable).values({
              email,
              googleId,
              createdAt: new Date(),
          });
          const userId = insertResult[0].insertId;
          const newUserResult = await db.select().from(UserTable)
          .where(eq(UserTable.id, userId))
          .limit(1);
          if (!newUserResult.length) {
              console.error('No se pudo encontrar el usuario de Google recién creado.');
              throw new Error("No se pudo encontrar el usuario de Google recién creado.");
          }
          user = newUserResult[0];
      }
      
      if (!user) { 
          console.error('No se pudo obtener o crear la información del usuario.');
              throw new Error("No se pudo obtener o crear la información del usuario.");
      }
      const token = await createAccessToken({ id: user.id });
      console.log('Generated JWT token for user:', user.id);

      // For React Native, always include token in redirect URL
      const url = new URL(redirectUri);
      url.searchParams.set('token', token as string);
      console.log('Redirecting to (with token):', url.toString());
      return c.redirect(url.toString());
  } catch (error: any) {
      console.error('💥 Google Callback Error:', error);
      console.error('💥 Error details:', error.message, error.stack);
      
      // Check for specific database errors
      if (error.code === 'ER_DUP_ENTRY') {
          console.error('💥 Database duplicate entry error');
          return c.redirect(`${redirectUri}?error=database_duplicate_entry`);
      } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
          console.error('💥 Database foreign key constraint error');
          return c.redirect(`${redirectUri}?error=database_constraint_error`);
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
          console.error('💥 Database connection error');
          return c.redirect(`${redirectUri}?error=database_connection_error`);
      }
      
      return c.redirect(`${redirectUri}?error=google_callback_failed`);
  }
})
