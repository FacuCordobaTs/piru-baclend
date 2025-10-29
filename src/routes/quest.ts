import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { eq, and, desc, gte, lt } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth'
import { dailyQuest, dailyQuestCompletion, user } from '../db/schema'

const questRoute = new Hono()

// Apply auth middleware to all routes
questRoute.use('*', authMiddleware)

// Get all daily quests for a user
questRoute.get('/daily', async (c) => {
  try {
    const db = drizzle(pool)
    const userId = (c as any).user.id
      
    const userDailyQuests = await db.select().from(dailyQuest)
      .where(eq(dailyQuest.userId, userId))
      .orderBy(desc(dailyQuest.createdAt))

    
    let newDailyQuests = [];    
    let newPointsLost = 0;
    let dailyQuestsNotCompleted = [];


    for (const dailyQuestItem of userDailyQuests) {
      const today = new Date()
      const dayOfWeek = today.getDay()
      const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
      const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)

      const scheduleDays = [
        dailyQuestItem.targetSunday,
        dailyQuestItem.targetMonday,
        dailyQuestItem.targetTuesday,
        dailyQuestItem.targetWednesday,
        dailyQuestItem.targetThursday,
        dailyQuestItem.targetFriday,
        dailyQuestItem.targetSaturday,
      ] // will be used  as a circullar array

      if (!scheduleDays[dayOfWeek]) {
        continue
      }


      const dailyQuestCompletionItem = await db.select().from(dailyQuestCompletion)
        .where(eq(dailyQuestCompletion.dailyQuestId, dailyQuestItem.id))
        .orderBy(desc(dailyQuestCompletion.completedAt))
        .limit(1)

      const hasCompletion = dailyQuestCompletionItem.length > 0
      const lastCompletedAt = hasCompletion ? dailyQuestCompletionItem[0].completedAt : null
      const lastCompletionDayOfWeek = lastCompletedAt ? lastCompletedAt.getDay() : null;

      let i = (dayOfWeek  - 1) % 7;

      while  (!scheduleDays[i] && i != lastCompletionDayOfWeek) {
        i = (i - 1) % 7;
      }

      if (i != lastCompletionDayOfWeek) {
        newPointsLost += dailyQuestItem.pointsReward || 10
        dailyQuestsNotCompleted.push(dailyQuestItem.id)
      }


      await db.update(dailyQuest).set({
        currentStreak: (i != lastCompletionDayOfWeek) ? 0 : (dailyQuestItem.currentStreak || 0),
      }).where(eq(dailyQuest.id, dailyQuestItem.id))

      newDailyQuests.push({
        ...dailyQuestItem,
        streak: (i != lastCompletionDayOfWeek) ? 0 : (dailyQuestItem.currentStreak || 0),
        completedToday: Boolean(hasCompletion && lastCompletedAt && lastCompletedAt >= startOfDay && lastCompletedAt < endOfDay)
      })
    }

    if (newPointsLost > 0) {
      const userItem = (c as any).user
      let newPoints = userItem.points - newPointsLost

      await db.update(user).set({
        points: newPoints,
      }).where(eq(user.id, userItem.id))
    }

    return c.json({
      success: true,
      data: newDailyQuests,
      dailyQuestsNotCompleted: dailyQuestsNotCompleted
    })
  } catch (error) {
    console.error('Error getting daily quests:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})


questRoute.get('/summary/weekly', async (c) => {
  try {
    const db = drizzle(pool)
    const userId = (c as any).user.id

    const startParam = c.req.query('start') // expects YYYY-MM-DD (local date)
    const now = startParam ? new Date(startParam) : new Date()

    // Compute start of week (Monday) in local time
    const currentDay = now.getDay() // 0 = Sunday, 1 = Monday, ...
    const diff = currentDay === 0 ? 6 : currentDay - 1
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff)

    // If startParam provided, use its local midnight as start instead
    const startOfRange = startParam
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
      : monday
    const endOfRange = new Date(startOfRange.getFullYear(), startOfRange.getMonth(), startOfRange.getDate() + 7)

    const dailyQuestCompletions = await db.select().from(dailyQuestCompletion)
      .where(and(
        eq(dailyQuestCompletion.userId, userId),
        gte(dailyQuestCompletion.completedAt, startOfRange),
        lt(dailyQuestCompletion.completedAt, endOfRange)
      ))

    // Helper to build YYYY-MM-DD in local time
    const toLocalDateKey = (d: Date) => {
      const y = d.getFullYear()
      const m = (d.getMonth() + 1).toString().padStart(2, '0')
      const day = d.getDate().toString().padStart(2, '0')
      return `${y}-${m}-${day}`
    }

    const completionCountByDay: Record<string, number> = {}
    for (const comp of dailyQuestCompletions) {
      const dateKey = toLocalDateKey(comp.completedAt)
      completionCountByDay[dateKey] = (completionCountByDay[dateKey] || 0) + 1
    }

    // Build 7-day array
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(startOfRange)
      d.setDate(startOfRange.getDate() + i)
      const key = toLocalDateKey(d)
      const count = completionCountByDay[key] || 0
      return {
        date: key,
        count,
        hasCompletion: count > 0
      }
    })

    return c.json({ success: true, data: { days } })
  } catch (error) {
    console.error('Error getting weekly summary:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})


const createDailyQuestSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  targetDays: z.array(z.boolean()),
  pointsReward: z.number().min(1),
  reminderTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).default('09:00'),
  expectedDuration: z.number().min(1).max(100),
})

questRoute.post('/daily', zValidator('json', createDailyQuestSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const db = drizzle(pool)
    const userId = (c as any).user.id

    const insertResult = await db.insert(dailyQuest).values({
      name: body.name,
      description: body.description ?? '',
      targetMonday: body.targetDays[0],
      userId: userId,
      targetTuesday:  body.targetDays[1],
      targetWednesday:  body.targetDays[2],
      targetThursday:  body.targetDays[3],
      targetFriday:  body.targetDays[4],
      targetSaturday:  body.targetDays[5],
      targetSunday:  body.targetDays[6],
      pointsReward: body.pointsReward,
      reminderTime: body.reminderTime || '09:00',
      expectedDuration: body.expectedDuration
    })
    
    const dailyQuestId = insertResult[0].insertId
    
    // Get the created daily quest
    const newDailyQuest = await db.select().from(dailyQuest)
      .where(eq(dailyQuest.id, dailyQuestId))
      .limit(1)
    

    return c.json({
      success: true,
      data: newDailyQuest[0],
      message: 'Daily quest created successfully'
    }, 201)
  } catch (error) {
    console.error('Error creating daily quest:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Update a daily quest
const updateDailyQuestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  targetDays: z.array(z.boolean()).optional(),
  pointsReward: z.number().min(1).max(100).optional(),
  reminderTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
  expectedDuration: z.number().min(1).max(100).optional(),
})

questRoute.put('/daily/:id', zValidator('json', updateDailyQuestSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const db = drizzle(pool)
    const userId = (c as any).user.id
    const dailyQuestId = parseInt(c.req.param('id'))
    
    if (isNaN(dailyQuestId)) {
      return c.json({ error: 'Invalid daily quest ID' }, 400)
    }
    
    // Check if daily quest exists and belongs to user
    const existingDailyQuest = await db.select().from(dailyQuest)
      .where(and(eq(dailyQuest.id, dailyQuestId), eq(dailyQuest.userId, userId)))
      .limit(1)
    
    if (!existingDailyQuest.length) {
      return c.json({ error: 'Daily quest not found' }, 404)
    }
    
    const updateData: any = {}
    if (body.name !== undefined) updateData.name = body.name
    if (body.description !== undefined) updateData.description = body.description
    if (body.pointsReward !== undefined) updateData.pointsReward = body.pointsReward
    if (body.reminderTime !== undefined) updateData.reminderTime = body.reminderTime
    if (body.expectedDuration !== undefined) updateData.expectedDuration = body.expectedDuration
    
    // Handle targetDays array conversion to individual day columns
    if (body.targetDays !== undefined) {
      updateData.targetMonday = body.targetDays[0] || false
      updateData.targetTuesday = body.targetDays[1] || false
      updateData.targetWednesday = body.targetDays[2] || false
      updateData.targetThursday = body.targetDays[3] || false
      updateData.targetFriday = body.targetDays[4] || false
      updateData.targetSaturday = body.targetDays[5] || false
      updateData.targetSunday = body.targetDays[6] || false
    }
    
    // Handle category flags
    await db.update(dailyQuest)
      .set(updateData)
      .where(and(eq(dailyQuest.id, dailyQuestId), eq(dailyQuest.userId, userId)))
    
    // Get the updated daily quest to return
    const updatedDailyQuest = await db.select().from(dailyQuest)
      .where(and(eq(dailyQuest.id, dailyQuestId), eq(dailyQuest.userId, userId)))
      .limit(1)
    
    if (!updatedDailyQuest.length) {
      return c.json({ error: 'Daily quest not found after update' }, 404)
    }
    
    return c.json({ 
      success: true, 
      data: updatedDailyQuest[0],
      message: 'Daily quest updated successfully' 
    })
  } catch (error) {
    console.error('Error updating daily quest:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Delete a daily quest
questRoute.delete('/daily/:id', async (c) => {
  try {
    const db = drizzle(pool)
    const userId = (c as any).user.id
    const dailyQuestId = parseInt(c.req.param('id'))
    
    if (isNaN(dailyQuestId)) {
      return c.json({ error: 'Invalid daily quest ID' }, 400)
    }
    
    // Check if daily quest exists and belongs to user
    const existingDailyQuest = await db.select().from(dailyQuest)
      .where(and(eq(dailyQuest.id, dailyQuestId), eq(dailyQuest.userId, userId)))
      .limit(1)
    
    if (!existingDailyQuest.length) {
      return c.json({ error: 'Daily quest not found' }, 404)
    }
    
    // Delete daily quest completions first (due to foreign key constraint)
    await db.delete(dailyQuestCompletion)
      .where(eq(dailyQuestCompletion.dailyQuestId, dailyQuestId))
    
    // Delete the daily quest
    await db.delete(dailyQuest)
      .where(and(eq(dailyQuest.id, dailyQuestId), eq(dailyQuest.userId, userId)))
    
    return c.json({ success: true, message: 'Daily quest deleted successfully' })
  } catch (error) {
    console.error('Error deleting daily quest:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Complete a daily quest (mark as done for today)
const completeDailyQuestSchema = z.object({
  mood: z.enum(['great', 'good', 'okay', 'bad']).optional()
})

questRoute.post('/daily/:id/complete', zValidator('json', completeDailyQuestSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const db = drizzle(pool)
    const userId = (c as any).user.id
    const dailyQuestId = parseInt(c.req.param('id'))
    
    if (isNaN(dailyQuestId)) {
      return c.json({ error: 'Invalid daily quest ID' }, 400)
    }
    
    // Check if daily quest exists
    const dailyQuestResult = await db.select().from(dailyQuest)
      .where(eq(dailyQuest.id, dailyQuestId))
      .limit(1)
    
    if (!dailyQuestResult.length || dailyQuestResult[0] == null) {
      return c.json({ error: 'Daily quest not found' }, 404)
    }
    
    const dailyQuestItem = dailyQuestResult[0]
    
    // Check if already completed today
    const today = new Date()
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const dayOfWeek = today.getDay()
    
    const existingCompletion = await db.select().from(dailyQuestCompletion)
      .where(and(
        eq(dailyQuestCompletion.dailyQuestId, dailyQuestId),
        gte(dailyQuestCompletion.completedAt, startOfDay),
      ))
      .limit(1)
    
    if (existingCompletion.length > 0) {
      return c.json({ error: 'Daily quest already completed today' }, 400)
    }
    
    // Determine if a scheduled day was missed since last completion (fetch BEFORE inserting today's completion)
    const lastCompletion = await db.select().from(dailyQuestCompletion)
      .where(eq(dailyQuestCompletion.dailyQuestId, dailyQuestId))
      .orderBy(desc(dailyQuestCompletion.completedAt))
      .limit(1)

    if (lastCompletion.length > 0) {
      return c.json({ error: 'Daily quest already completed today' }, 400)
    }
    
    await db.insert(dailyQuestCompletion).values({
      dailyQuestId: dailyQuestId,
      userId: userId,
      mood: body.mood,
      dayOfTheWeek: dayOfWeek
    })
    
    await db.update(dailyQuest)
      .set({
        currentStreak: (dailyQuestItem.currentStreak || 0) + 1,
      })
      .where(eq(dailyQuest.id, dailyQuestId))
    
    // Add experience to user
    const user = (c as any).user
    const experienceGained = dailyQuestItem.pointsReward || 10	
    let newPoints = user.points + experienceGained

    let newGlobalQuestsStreak = user.globalQuestsStreak
    if (user.lastCompletion < new Date(today.getFullYear(), today.getMonth(), today.getDate()) || user.lastCompletion === null || user.globalHabitsStreak == 0) {
        newGlobalQuestsStreak += 1
    }

    await db.update(user)
      .set({
        points: newPoints,
        globalQuestsStreak: newGlobalQuestsStreak,
        lastCompletion: new Date(today.getFullYear(), today.getMonth(), today.getDate())
      })
      .where(eq(user.id, userId))

    
    return c.json({
      success: true,
      data: {
        dailyQuestId: dailyQuestId,
        newStreak: (dailyQuestItem.currentStreak || 0) + 1,
        newPoints: newPoints,
        newGlobalQuestsStreak: newGlobalQuestsStreak,
        lastCompletion: new Date(today.getFullYear(), today.getMonth(), today.getDate())
      },
      message: 'Daily quest completed successfully!'
    })
  } catch (error) {
    console.error('Error completing daily quest:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})



export { questRoute }
