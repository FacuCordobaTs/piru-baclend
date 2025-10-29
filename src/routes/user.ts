import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { user as UserTable } from '../db/schema'
import { desc } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth'

const userRoute = new Hono()

// Apply auth middleware to all routes
userRoute.use('*', authMiddleware)

userRoute.get('/leaderboard', async (c) => {
  try {
    const db = drizzle(pool)
    const pointsLeaderboard = await db.select().from(UserTable).orderBy(desc(UserTable.points)).limit(10)
    return c.json({ success: true, data: { pointsLeaderboard } })
  } catch (error) {
    console.error('Error getting leaderboard:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export { userRoute }