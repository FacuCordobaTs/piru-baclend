import { Context, Next } from 'hono'
import * as jwt from 'jsonwebtoken'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { users } from '../db/schema'
import { eq } from 'drizzle-orm'

export interface AuthenticatedContext extends Context {
  user: {
    id: number
    email: string
    name?: string
    level: number
    experience: number
    experienceToNext: number
    longestStreak: number
    avatar?: string
    physicalPoints: number
    mentalPoints: number
    spiritualPoints: number
    disciplinePoints: number
    socialPoints: number
    lastRelapse: Date | null
    completedQuiz: boolean
    referalCode: string | null
    globalHabitsStreak: number
    class: string
  }
}

export const authMiddleware = async (c: Context, next: Next) => {
  // For React Native apps, we only use Authorization header
  const authHeader = c.req.header('Authorization')
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization header required' }, 401)
  }

  const token = authHeader.substring(7) // Remove 'Bearer ' prefix

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret') as { id: number }
    
    const db = drizzle(pool)
    const userResult = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1)
    
    if (!userResult.length) {
      return c.json({ error: 'User not found' }, 401)
    }

    const user = userResult[0]
    const lastCompletion = user.lastCompletion ? new Date(user.lastCompletion) : null
    if (lastCompletion && (Date.now() - lastCompletion.getTime() > 24 * 60 * 60 * 1000)) {
      user.globalHabitsStreak = 0
    }
    
    ;(c as AuthenticatedContext).user = {
      id: user.id,
      email: user.email,
      name: user.name || undefined,
      level: user.level || 1,
      experience: user.experience || 0,
      experienceToNext: user.experienceToNext || 100,
      longestStreak: user.longestStreak || 0,
      avatar: user.avatar || undefined,
      physicalPoints: user.physicalPoints || 0,
      mentalPoints: user.mentalPoints || 0,
      spiritualPoints: user.spiritualPoints || 0,
      disciplinePoints: user.disciplinePoints || 0,
      socialPoints: user.socialPoints || 0,
      lastRelapse: user.lastRelapse || null,
      completedQuiz: user.completedQuiz || false,
      referalCode: user.referalCode || null,
      globalHabitsStreak: user.globalHabitsStreak || 0,
      class: user.class || "Guerrero",
    }

    await next()
  } catch (error) {
    return c.json({ error: 'Invalid token' }, 401)
  }
}
