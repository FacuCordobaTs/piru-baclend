import 'dotenv/config';
import { Hono } from 'hono'
import { authRoute } from './routes/auth'
import { userRoute } from './routes/user'
import { habitRoute } from './routes/habit'

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

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.basePath('/api')
  .route('/auth', authRoute)
  .route('/user', userRoute)
  .route('/habits', habitRoute)
  
export default app
