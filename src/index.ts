import 'dotenv/config';
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRoute } from './routes/auth'
import { userRoute } from './routes/user'
import { questRoute } from './routes/quest'

// Validate required environment variables
const requiredEnvVars = [
  'DB_USER',
  'DB_PASSWORD', 
  'DB_NAME',
  'JWT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

console.log('✅ All required environment variables are present');

const app = new Hono()

// Configure CORS
app.use('*', cors({
  origin: [
    'http://localhost:4321', // Astro dev server
    'http://localhost:3000', // Alternative dev port
    'https://piru.app', // Production domain
    'https://www.piru.app', // Production domain with www
    'https://landing.piru.app', // Landing page subdomain
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}))

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.basePath('/api')
  .route('/auth', authRoute)
  .route('/user', userRoute)
  .route('/quests', questRoute)
  
export default app
