import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { users, userSettings } from '../db/schema'
import { desc, eq } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth'

const userRoute = new Hono()

// Apply auth middleware to all routes
userRoute.use('*', authMiddleware)

// Get user profile
userRoute.get('/profile', async (c) => {
  try {
    const db = drizzle(pool)
    const userId = (c as any).user.id
    
    // Get user settings
    const settingsResult = await db.select().from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1)
    
    const settings = settingsResult.length > 0 ? settingsResult[0] : null
    
    return c.json({
      success: true,
      data: {
        user: (c as any).user,
        settings: settings ? {
          notificationsEnabled: settings.notificationsEnabled,
          language: settings.language
        } : null
      }
    })
  } catch (error) {
    console.error('Error getting user profile:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Update user profile
const completeQuizSchema = z.object({
  name: z.string().min(1).max(255),
  // avatar: z.string().url().optional(),
  age: z.number().min(1).max(120),
  physicalPoints: z.number().min(1).max(100),
  mentalPoints: z.number().min(1).max(100),
  spiritualPoints: z.number().min(1).max(100),
  disciplinePoints:  z.number().min(1).max(100),
  socialPoints:  z.number().min(1).max(100),
  completedQuiz: z.boolean(),
})

userRoute.put('/complete-quiz', zValidator('json', completeQuizSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const db = drizzle(pool)
    const userId = (c as any).user.id
    
    await db.update(users)
      .set(body)
      .where(eq(users.id, userId))
    
    return c.json({ success: true, message: 'Profile updated successfully' })
  } catch (error) {
    console.error('Error updating user profile:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Update user settings
const updateSettingsSchema = z.object({
  notificationsEnabled: z.boolean().optional(),
  reminderTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
  language: z.string().length(2).optional()
})

userRoute.put('/settings', zValidator('json', updateSettingsSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const db = drizzle(pool)
    const userId = (c as any).user.id
    
    // Check if settings exist
    const existingSettings = await db.select().from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1)
    
    if (existingSettings.length > 0) {
      // Update existing settings
      const updateData: any = {}
      if (body.notificationsEnabled !== undefined) updateData.notificationsEnabled = body.notificationsEnabled
      if (body.reminderTime !== undefined) updateData.reminderTime = body.reminderTime
      if (body.language !== undefined) updateData.language = body.language
      
      await db.update(userSettings)
        .set(updateData)
        .where(eq(userSettings.userId, userId))
    } else {
      // Create new settings
      await db.insert(userSettings).values({
        userId: userId,
        notificationsEnabled: body.notificationsEnabled ?? true,
        language: body.language ?? 'es'
      })
    }
    
    return c.json({ success: true, message: 'Settings updated successfully' })
  } catch (error) {
    console.error('Error updating user settings:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Add experience to user (for gamification)
const addExperienceSchema = z.object({
  experience: z.number().min(1).max(1000)
})

userRoute.post('/experience', zValidator('json', addExperienceSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const db = drizzle(pool)
    const user = (c as any).user
    
    const newExperience = user.experience + body.experience
    let newLevel = user.level
    let newExperienceToNext = user.experienceToNext
    
    // Check if user leveled up
    if (newExperience >= user.experienceToNext) {
      newLevel += 1
      newExperienceToNext = Math.floor(user.experienceToNext * 1.5) // Increase XP requirement by 50%
    }
    
    await db.update(users)
      .set({
        experience: newExperience,
        level: newLevel,
        experienceToNext: newExperienceToNext
      })
      .where(eq(users.id, user.id))
    
    const leveledUp = newLevel > user.level
    
    return c.json({
      success: true,
      data: {
        newExperience,
        newLevel,
        newExperienceToNext,
        leveledUp,
        experienceGained: body.experience
      }
    })
  } catch (error) {
    console.error('Error adding experience:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Update user streak
const updateStreakSchema = z.object({
  currentStreak: z.number().min(0)
})

userRoute.put('/streak', zValidator('json', updateStreakSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const db = drizzle(pool)
    const user = (c as any).user
    
    const newLongestStreak = Math.max(user.longestStreak, body.currentStreak)
    
    await db.update(users)
      .set({
        longestStreak: newLongestStreak
      })
      .where(eq(users.id, user.id))
    
    return c.json({
      success: true,
      data: {
        currentStreak: body.currentStreak,
        longestStreak: newLongestStreak
      }
    })
  } catch (error) {
    console.error('Error updating streak:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Get user statistics
userRoute.get('/stats', async (c) => {
  try {
    const db = drizzle(pool)
    const user = (c as any).user
    
    // Get user's habits for additional stats
    const { habits } = await import('../db/schema')
    const userHabits = await db.select().from(habits)
      .where(eq(habits.userId, user.id))
    
    const totalHabits = userHabits.length
    const activeHabits = userHabits.filter(h => (h.currentStreak || 0) > 0).length
    
    // Calculate total experience from habits
    const totalExperienceFromHabits = userHabits.reduce((sum, habit) => {
      return sum + ((habit.currentStreak || 0) * (habit.experienceReward || 10))
    }, 0)
    
    return c.json({
      success: true,
      data: {
        level: user.level,
        experience: user.experience,
        experienceToNext: user.experienceToNext,
        currentStreak: user.currentStreak,
        longestStreak: user.longestStreak,
        totalHabits,
        activeHabits,
        totalExperienceFromHabits,
        progressToNextLevel: Math.round((user.experience / user.experienceToNext) * 100)
      }
    })
  } catch (error) {
    console.error('Error getting user stats:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

userRoute.get('/leaderboard', async (c) => {
  try {
    const db = drizzle(pool)
    const nofapLeaderboard = await db.select().from(users).orderBy(desc(users.longestStreak)).limit(10)
    const levelLeaderboard = await db.select().from(users).orderBy(desc(users.level)).limit(10)
    return c.json({ success: true, data: { nofapLeaderboard, levelLeaderboard } })
  } catch (error) {
    console.error('Error getting leaderboard:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

const referalSchema = z.object({
  referalCode: z.string().min(1).max(255)
})

userRoute.post('/referal', zValidator('json', referalSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const db = drizzle(pool)
    const user = (c as any).user

    await db.update(users).set({ referalCode: body.referalCode }).where(eq(users.id, user.id))
      
    return c.json({ success: true, data: { referalCode: body.referalCode } })
  } catch (error) {
    console.error('Error getting referal:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export { userRoute }
