import { Hono } from 'hono'
import { authRoute } from './routes/auth'
import { userRoute } from './routes/user'
import { habitRoute } from './routes/habit'

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.basePath('/api')
  .route('/auth', authRoute)
  .route('/user', userRoute)
  .route('/habits', habitRoute)
  
export default app
