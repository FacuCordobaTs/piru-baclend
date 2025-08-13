import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { habits, habitCompletions, users } from '../db/schema'
import { eq, and, desc, gte, lt } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth'

const habitRoute = new Hono()

// Apply auth middleware to all routes
habitRoute.use('*', authMiddleware)

// Get all habits for a user
habitRoute.get('/', async (c) => {
  try {
    const db = drizzle(pool)
    const userId = (c as any).user.id
    
    const userHabits = await db.select().from(habits)
      .where(eq(habits.userId, userId))
      .orderBy(desc(habits.createdAt))
    
    return c.json({
      success: true,
      data: userHabits
    })
  } catch (error) {
    console.error('Error getting habits:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Get a specific habit by ID
habitRoute.get('/:id', async (c) => {
  try {
    const db = drizzle(pool)
    const userId = (c as any).user.id
    const habitId = parseInt(c.req.param('id'))
    
    if (isNaN(habitId)) {
      return c.json({ error: 'Invalid habit ID' }, 400)
    }
    
    const habitResult = await db.select().from(habits)
      .where(eq(habits.id, habitId))
      .limit(1)
    
    if (!habitResult.length) {
      return c.json({ error: 'Habit not found' }, 404)
    }
    
    // Get recent completions for this habit
    const completions = await db.select().from(habitCompletions)
      .where(eq(habitCompletions.habitId, habitId))
      .orderBy(desc(habitCompletions.completedAt))
      .limit(10)
    
    return c.json({
      success: true,
      data: {
        habit: habitResult[0],
        recentCompletions: completions
      }
    })
  } catch (error) {
    console.error('Error getting habit:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Create a new habit
const createHabitSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  targetDays: z.number().min(1).max(365).default(7),
  experienceReward: z.number().min(1).max(100).default(10),
  reminderTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).default('09:00')
})

habitRoute.post('/', zValidator('json', createHabitSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const db = drizzle(pool)
    const userId = (c as any).user.id
    
    const insertResult = await db.insert(habits).values({
      userId: userId,
      name: body.name,
      description: body.description,
      targetDays: body.targetDays,
      experienceReward: body.experienceReward,
      reminderTime: body.reminderTime
    })
    
    const habitId = insertResult[0].insertId
    
    // Get the created habit
    const newHabit = await db.select().from(habits)
      .where(eq(habits.id, habitId))
      .limit(1)
    
    return c.json({
      success: true,
      data: newHabit[0],
      message: 'Habit created successfully'
    }, 201)
  } catch (error) {
    console.error('Error creating habit:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Update a habit
const updateHabitSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  targetDays: z.number().min(1).max(365).optional(),
  experienceReward: z.number().min(1).max(100).optional(),
  reminderTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).optional()
})

habitRoute.put('/:id', zValidator('json', updateHabitSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const db = drizzle(pool)
    const userId = (c as any).user.id
    const habitId = parseInt(c.req.param('id'))
    
    if (isNaN(habitId)) {
      return c.json({ error: 'Invalid habit ID' }, 400)
    }
    
    // Check if habit exists and belongs to user
    const existingHabit = await db.select().from(habits)
      .where(eq(habits.id, habitId))
      .limit(1)
    
    if (!existingHabit.length) {
      return c.json({ error: 'Habit not found' }, 404)
    }
    
    const updateData: any = {}
    if (body.name !== undefined) updateData.name = body.name
    if (body.description !== undefined) updateData.description = body.description
    if (body.targetDays !== undefined) updateData.targetDays = body.targetDays
    if (body.experienceReward !== undefined) updateData.experienceReward = body.experienceReward
    if (body.reminderTime !== undefined) updateData.reminderTime = body.reminderTime
    
    await db.update(habits)
      .set(updateData)
      .where(eq(habits.id, habitId))
    
    return c.json({ success: true, message: 'Habit updated successfully' })
  } catch (error) {
    console.error('Error updating habit:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Delete a habit
habitRoute.delete('/:id', async (c) => {
  try {
    const db = drizzle(pool)
    const userId = (c as any).user.id
    const habitId = parseInt(c.req.param('id'))
    
    if (isNaN(habitId)) {
      return c.json({ error: 'Invalid habit ID' }, 400)
    }
    
    // Check if habit exists and belongs to user
    const existingHabit = await db.select().from(habits)
      .where(and(eq(habits.id, habitId), eq(habits.userId, userId)))
      .limit(1)
    
    if (!existingHabit.length) {
      return c.json({ error: 'Habit not found' }, 404)
    }
    
    // Delete habit completions first (due to foreign key constraint)
    await db.delete(habitCompletions)
      .where(eq(habitCompletions.habitId, habitId))
    
    // Delete the habit
    await db.delete(habits)
      .where(and(eq(habits.id, habitId), eq(habits.userId, userId)))
    
    return c.json({ success: true, message: 'Habit deleted successfully' })
  } catch (error) {
    console.error('Error deleting habit:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Complete a habit (mark as done for today)
const completeHabitSchema = z.object({
  notes: z.string().optional(),
  mood: z.enum(['great', 'good', 'okay', 'bad']).optional()
})

habitRoute.post('/:id/complete', zValidator('json', completeHabitSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const db = drizzle(pool)
    const userId = (c as any).user.id
    const habitId = parseInt(c.req.param('id'))
    
    if (isNaN(habitId)) {
      return c.json({ error: 'Invalid habit ID' }, 400)
    }
    
    // Check if habit exists and belongs to user
    const habitResult = await db.select().from(habits)
      .where(and(eq(habits.id, habitId), eq(habits.userId, userId)))
      .limit(1)
    
    if (!habitResult.length) {
      return c.json({ error: 'Habit not found' }, 404)
    }
    
    const habit = habitResult[0]
    
    // Check if already completed today
    const today = new Date()
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
    
    const existingCompletion = await db.select().from(habitCompletions)
      .where(and(
        eq(habitCompletions.habitId, habitId),
        eq(habitCompletions.userId, userId),
        gte(habitCompletions.completedAt, startOfDay),
        lt(habitCompletions.completedAt, endOfDay)
      ))
      .limit(1)
    
    if (existingCompletion.length > 0) {
      return c.json({ error: 'Habit already completed today' }, 400)
    }
    
    // Create completion record
    await db.insert(habitCompletions).values({
      habitId: habitId,
      userId: userId,
      notes: body.notes,
      mood: body.mood
    })
    
    // Update habit streak
    const newStreak = (habit.currentStreak || 0) + 1
    const newLongestStreak = Math.max(habit.longestStreak || 0, newStreak)
    
    await db.update(habits)
      .set({
        currentStreak: newStreak,
        longestStreak: newLongestStreak
      })
      .where(eq(habits.id, habitId))
    
    // Add experience to user
    const user = (c as any).user
    const experienceGained = habit.experienceReward || 10
    const newExperience = user.experience + experienceGained
    let newLevel = user.level
    let newExperienceToNext = user.experienceToNext
    
    // Check if user leveled up
    if (newExperience >= user.experienceToNext) {
      newLevel += 1
      newExperienceToNext = Math.floor(user.experienceToNext * 1.5)
    }
    
    await db.update(users)
      .set({
        experience: newExperience,
        level: newLevel,
        experienceToNext: newExperienceToNext
      })
      .where(eq(users.id, userId))
    
    return c.json({
      success: true,
      data: {
        habitId: habitId,
        newStreak: newStreak,
        newLongestStreak: newLongestStreak,
        experienceGained: experienceGained,
        newUserExperience: newExperience,
        newUserLevel: newLevel,
        leveledUp: newLevel > user.level
      },
      message: 'Habit completed successfully!'
    })
  } catch (error) {
    console.error('Error completing habit:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Get habit completions
habitRoute.get('/:id/completions', async (c) => {
  try {
    const db = drizzle(pool)
    const userId = (c as any).user.id
    const habitId = parseInt(c.req.param('id'))
    const limit = parseInt(c.req.query('limit') || '30')
    const offset = parseInt(c.req.query('offset') || '0')
    
    if (isNaN(habitId)) {
      return c.json({ error: 'Invalid habit ID' }, 400)
    }
    
    // Check if habit exists and belongs to user
    const habitResult = await db.select().from(habits)
      .where(and(eq(habits.id, habitId), eq(habits.userId, userId)))
      .limit(1)
    
    if (!habitResult.length) {
      return c.json({ error: 'Habit not found' }, 404)
    }
    
    const completions = await db.select().from(habitCompletions)
      .where(eq(habitCompletions.habitId, habitId))
      .orderBy(desc(habitCompletions.completedAt))
      .limit(limit)
      .offset(offset)
    
    return c.json({
      success: true,
      data: completions
    })
  } catch (error) {
    console.error('Error getting habit completions:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export { habitRoute }
