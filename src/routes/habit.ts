import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { habits, habitCompletions, users, relapse } from '../db/schema'
import { eq, and, desc, gte, lt } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth'

const habitRoute = new Hono()

// Apply auth middleware to all routes
habitRoute.use('*', authMiddleware)

// Helper function to convert individual day columns to targetDays array
const convertDaysToArray = (habit: any) => {
  return {
    ...habit,
    targetDays: [
      habit.targetMonday || false,
      habit.targetTuesday || false,
      habit.targetWednesday || false,
      habit.targetThursday || false,
      habit.targetFriday || false,
      habit.targetSaturday || false,
      habit.targetSunday || false
    ]
  }
}

interface Habit {
  streak: number;
  completedToday: boolean;
}


// Get all habits for a user
habitRoute.get('/', async (c) => {
  try {
    const db = drizzle(pool)
    const userId = (c as any).user.id
    
    const userHabits = await db.select().from(habits)
      .where(eq(habits.userId, userId))
      .orderBy(desc(habits.createdAt))

    let newHabits = [];    
    if (userHabits.length !== 0) {
      for (const habit of userHabits) {
        const today = new Date()
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
        const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)

        const dayOfWeek = today.getDay()
        const scheduleDays = [
          habit.targetSunday,
          habit.targetMonday,
          habit.targetTuesday,
          habit.targetWednesday,
          habit.targetThursday,
          habit.targetFriday,
          habit.targetSaturday,
        ]

        if (!scheduleDays[dayOfWeek]) {
          continue
        }

        const habitCompletion = await db.select().from(habitCompletions)
          .where(eq(habitCompletions.habitId, habit.id))
          .orderBy(desc(habitCompletions.completedAt))
          .limit(1)

        const hasCompletion = habitCompletion.length > 0
        const lastCompletedAt = hasCompletion ? habitCompletion[0].completedAt : null

        let missedSinceLast = false
        if (hasCompletion && lastCompletedAt) {
          const dayAfterLast = new Date(
            lastCompletedAt.getFullYear(),
            lastCompletedAt.getMonth(),
            lastCompletedAt.getDate() + 1
          )
          missedSinceLast = Boolean(habit.nextSchedule && habit.nextSchedule > dayAfterLast)
        }

        newHabits.push({
          ...convertDaysToArray(habit),
          streak: missedSinceLast ? 0 : (habit.currentStreak || 0),
          completedToday: Boolean(hasCompletion && lastCompletedAt && lastCompletedAt >= startOfDay && lastCompletedAt < endOfDay)
        })
      }
    }

    return c.json({
      success: true,
      data: newHabits
    })
  } catch (error) {
    console.error('Error getting habits:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Relapse routes (must come before /:id to avoid route conflicts)
const relapseSchema = z.object({
  relapseReason: z.string().min(1).max(255),
  relapseDate: z.string().datetime().transform((dateString) => new Date(dateString))
})

habitRoute.post('/relapse', zValidator('json', relapseSchema), async (c) => {
  try {
    const db = drizzle(pool)
    const user = (c as any).user
    const body = c.req.valid('json')
    await db.insert(relapse).values({
      userId: user.id,
      relapseReason: body.relapseReason,
      relapseDate: body.relapseDate
    })
    
    // Calculate streak only if user has a previous relapse
    let newLongestStreak = user.longestStreak || 0;
    if (user.lastRelapse) {
      const lastRelapseDate = new Date(user.lastRelapse);
      const today = new Date(body.relapseDate);
      const lastStreak = Math.floor((today.getTime() - lastRelapseDate.getTime()) / (1000 * 60 * 60 * 24));
      newLongestStreak = user.longestStreak > lastStreak ? user.longestStreak : lastStreak;
    }

    await db.update(users).set({
      lastRelapse: body.relapseDate,
      longestStreak: newLongestStreak
    }).where(eq(users.id, user.id));

    return c.json({ success: true, message: 'Relapse recorded successfully' })
  }
  catch (error) {
    console.error('Error recording relapse:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

habitRoute.get('/relapses', async (c) => {
  try {
    const db = drizzle(pool)
    const user = (c as any).user
    const relapses = await db.select().from(relapse).where(eq(relapse.userId, user.id)).orderBy(desc(relapse.relapseDate)).limit(10)
    return c.json({ success: true, data: relapses })
  }
  catch (error) {
    console.error('Error getting relapses:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Weekly completion summary for the current user
// Returns 7 days starting from the provided start date (expected Monday), or current week if not provided
habitRoute.get('/summary/weekly', async (c) => {
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

    const completions = await db.select().from(habitCompletions)
      .where(and(
        eq(habitCompletions.userId, userId),
        gte(habitCompletions.completedAt, startOfRange),
        lt(habitCompletions.completedAt, endOfRange)
      ))

    // Helper to build YYYY-MM-DD in local time
    const toLocalDateKey = (d: Date) => {
      const y = d.getFullYear()
      const m = (d.getMonth() + 1).toString().padStart(2, '0')
      const day = d.getDate().toString().padStart(2, '0')
      return `${y}-${m}-${day}`
    }

    const completionCountByDay: Record<string, number> = {}
    for (const comp of completions) {
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

// Get a specific habit by ID
habitRoute.get('/:id', async (c) => {
  try {
    const db = drizzle(pool)
    const userId = (c as any).user.id
    const habitId = parseInt(c.req.param('id'))
    

    const startOfDay = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())
    const endOfDay = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1)

    if (isNaN(habitId)) {
      return c.json({ error: 'Invalid habit ID' }, 400)
    }
    
    const habitResult = await db.select().from(habits)
      .where(and(eq(habits.id, habitId), eq(habits.userId, userId)))
      .limit(1)
    
    if (!habitResult.length) {
      return c.json({ error: 'Habit not found' }, 404)
    }
    
    const dayOfWeek = new Date().getDay()
    const scheduleDays = [
      habitResult[0].targetSunday,
      habitResult[0].targetMonday,
      habitResult[0].targetTuesday,
      habitResult[0].targetWednesday,
      habitResult[0].targetThursday,
      habitResult[0].targetFriday,
      habitResult[0].targetSaturday,
    ]

    if (!scheduleDays[dayOfWeek]) {
      return c.json({ error: 'Habit not scheduled for today' }, 400)
    }
    // Get recent completions for this habit
    const completions = await db.select().from(habitCompletions)
      .where(eq(habitCompletions.habitId, habitId))
      .orderBy(desc(habitCompletions.completedAt))
      .limit(10)

    const habit = habitResult[0]
      if (completions.length == 0 || (habit.nextSchedule && habit.nextSchedule > (new Date(completions[0].completedAt.getFullYear(), completions[0].completedAt.getMonth(), completions[0].completedAt.getDate() + 1)))) {
        return c.json({ 
          ...convertDaysToArray(habit),
          streak: 0,
          completedToday: false
        })
      }
      else {
        return c.json({ 
          ...convertDaysToArray(habit),
          streak: (habit.currentStreak || 0),
          completedToday: (completions[0].completedAt >= startOfDay && completions[0].completedAt < endOfDay )
        })
      }
    
  } catch (error) {
    console.error('Error getting habit:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Create a new habit
const createHabitSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  targetDays: z.array(z.boolean()),
  experienceReward: z.number().min(1),
  reminderTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).default('09:00'),
  categories: z.array(z.boolean()),
})

const getNextSchedule = (habit: any, date: Date) => {
  const dayOfWeek = date.getDay()
  const scheduleDays = [
    habit.targetSunday,
    habit.targetMonday,
    habit.targetTuesday,
    habit.targetWednesday,
    habit.targetThursday,
    habit.targetFriday,
    habit.targetSaturday,
  ]

  let i = dayOfWeek;
  let j = 0;
  while (!scheduleDays[i] && j < 7) {
    i = (i + 1) % 7
    j++
  }

  return scheduleDays[i] ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + j) : null
}



habitRoute.post('/', zValidator('json', createHabitSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const db = drizzle(pool)
    const userId = (c as any).user.id
    
    const insertResult = await db.insert(habits).values({
      userId: userId,
      name: body.name,
      targetMonday: body.targetDays[0],
      targetTuesday:  body.targetDays[1],
      targetWednesday:  body.targetDays[2],
      targetThursday:  body.targetDays[3],
      targetFriday:  body.targetDays[4],
      targetSaturday:  body.targetDays[5],
      targetSunday:  body.targetDays[6],
      experienceReward: body.experienceReward,
      nextSchedule: getNextSchedule({
        targetSunday: body.targetDays[6],
        targetMonday: body.targetDays[0],
        targetTuesday: body.targetDays[1],
        targetWednesday: body.targetDays[2],
        targetThursday: body.targetDays[3],
        targetFriday: body.targetDays[4],
        targetSaturday: body.targetDays[5]
      }, new Date()),
      reminderTime: body.reminderTime,
      physical: body.categories[0],
      mental: body.categories[1],
      spiritual: body.categories[2],
      discipline: body.categories[3],
      social: body.categories[4],
    })
    
    const habitId = insertResult[0].insertId
    
    // Get the created habit
    const newHabit = await db.select().from(habits)
      .where(eq(habits.id, habitId))
      .limit(1)
    
    const habitResult = { ...convertDaysToArray(newHabit[0]), completedToday: false }

    return c.json({
      success: true,
      data: habitResult,
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
  targetDays: z.array(z.boolean()).optional(),
  experienceReward: z.number().min(1).max(100).optional(),
  reminderTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
  physical: z.boolean().optional(),
  mental: z.boolean().optional(),
  spiritual: z.boolean().optional(),
  discipline: z.boolean().optional(),
  social: z.boolean().optional()
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
      .where(and(eq(habits.id, habitId), eq(habits.userId, userId)))
      .limit(1)
    
    if (!existingHabit.length) {
      return c.json({ error: 'Habit not found' }, 404)
    }
    
    const updateData: any = {}
    if (body.name !== undefined) updateData.name = body.name
    if (body.description !== undefined) updateData.description = body.description
    if (body.experienceReward !== undefined) updateData.experienceReward = body.experienceReward
    if (body.reminderTime !== undefined) updateData.reminderTime = body.reminderTime
    
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
    if (body.physical !== undefined) updateData.physical = body.physical
    if (body.mental !== undefined) updateData.mental = body.mental
    if (body.spiritual !== undefined) updateData.spiritual = body.spiritual
    if (body.discipline !== undefined) updateData.discipline = body.discipline
    if (body.social !== undefined) updateData.social = body.social
    // Compute next schedule based on merged current + updates to avoid missing fields
    const scheduleSource = { ...existingHabit[0], ...updateData }
    updateData.nextSchedule = getNextSchedule(scheduleSource, new Date());

    await db.update(habits)
      .set(updateData)
      .where(and(eq(habits.id, habitId), eq(habits.userId, userId)))
    
    // Get the updated habit to return
    const updatedHabit = await db.select().from(habits)
      .where(and(eq(habits.id, habitId), eq(habits.userId, userId)))
      .limit(1)
    
    if (!updatedHabit.length) {
      return c.json({ error: 'Habit not found after update' }, 404)
    }
    
    return c.json({ 
      success: true, 
      data: convertDaysToArray(updatedHabit[0]),
      message: 'Habit updated successfully' 
    })
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
    
    // Determine if a scheduled day was missed since last completion (fetch BEFORE inserting today's completion)
    const lastCompletion = await db.select().from(habitCompletions)
      .where(eq(habitCompletions.habitId, habitId))
      .orderBy(desc(habitCompletions.completedAt))
      .limit(1)

    const hasLast = lastCompletion.length > 0
    const lastAt = hasLast ? lastCompletion[0].completedAt : null
    let missedSinceLast = false
    if (hasLast && lastAt) {
      const dayAfterLast = new Date(
        lastAt.getFullYear(),
        lastAt.getMonth(),
        lastAt.getDate() + 1
      )
      missedSinceLast = Boolean(habit.nextSchedule && habit.nextSchedule > dayAfterLast)
    }

    // Create completion record (now insert today's completion)
    await db.insert(habitCompletions).values({
      habitId: habitId,
      userId: userId,
      mood: body.mood
    })

    // Update habit streak
    const baseStreak = missedSinceLast ? 0 : (habit.currentStreak || 0)
    const newStreak = baseStreak + 1
    const newLongestStreak = Math.max(habit.longestStreak || 0, newStreak)
    
    await db.update(habits)
      .set({
        currentStreak: newStreak,
        longestStreak: newLongestStreak,
        nextSchedule: getNextSchedule(habit, new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1))
      })
      .where(eq(habits.id, habitId))
    
    // Add experience to user
    const user = (c as any).user
    const experienceGained = habit.experienceReward || 10
    let newExperience = user.experience + experienceGained
    let newLevel = user.level
    let newExperienceToNext = user.experienceToNext

    // Check if user leveled up
    if (newExperience >= user.experienceToNext) {
      newLevel += 1
      newExperience = newExperience - newExperienceToNext;
      newExperienceToNext = Math.floor(user.experienceToNext * 1.5)
    }

    let newGlobalHabitsStreak = user.globalHabitsStreak
    if (user.lastCompletion < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
        newGlobalHabitsStreak += 1
    }

    await db.update(users)
      .set({
        experience: newExperience,
        level: newLevel,
        experienceToNext: newExperienceToNext,
        physicalPoints: habit.physical ? ((user.physicalPoints + (experienceGained/10)) > 100 ? 100 : (user.physicalPoints + (experienceGained/10))) : (user.physicalPoints || 0),
        mentalPoints: habit.mental ? ((user.mentalPoints + (experienceGained/10)) > 100 ? 100 : (user.mentalPoints + (experienceGained/10))) : (user.mentalPoints || 0),
        spiritualPoints: habit.spiritual ? ((user.spiritualPoints + (experienceGained/10)) > 100 ? 100 : (user.spiritualPoints + (experienceGained/10))) : (user.spiritualPoints || 0),
        disciplinePoints: habit.discipline ? ((user.disciplinePoints + (experienceGained/10)) > 100 ? 100 : (user.disciplinePoints + (experienceGained/10))) : (user.disciplinePoints || 0),
        socialPoints: habit.social ? ((user.socialPoints + (experienceGained/10)) > 100 ? 100 : (user.socialPoints + (experienceGained/10))) : (user.socialPoints || 0),
        globalHabitsStreak: newGlobalHabitsStreak,
        lastCompletion: new Date(today.getFullYear(), today.getMonth(), today.getDate())
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
        leveledUp: newLevel > user.level,
        physicalPoints: habit.physical ? ((user.physicalPoints + (experienceGained/10)) > 100 ? 100 : (user.physicalPoints + (experienceGained/10))) : (user.physicalPoints || 0),
        mentalPoints: habit.mental ? ((user.mentalPoints + (experienceGained/10)) > 100 ? 100 : (user.mentalPoints + (experienceGained/10))) : (user.mentalPoints || 0),
        spiritualPoints: habit.spiritual ? (user.spiritualPoints + (experienceGained/10)) : (user.spiritualPoints || 0),
        disciplinePoints: habit.discipline ? ((user.disciplinePoints + (experienceGained/10)) > 100 ? 100 : (user.disciplinePoints + (experienceGained/10))) : (user.disciplinePoints || 0),
        socialPoints: habit.social ? ((user.socialPoints + (experienceGained/10)) > 100 ? 100 : (user.socialPoints + (experienceGained/10))) : (user.socialPoints || 0),
        globalHabitsStreak: newGlobalHabitsStreak,
        lastCompletion: new Date(today.getFullYear(), today.getMonth(), today.getDate())
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

// Get habit statistics
habitRoute.get('/:id/stats', async (c) => {
  try {
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
    
    // Get completion statistics
    const allCompletions = await db.select().from(habitCompletions)
      .where(eq(habitCompletions.habitId, habitId))
      .orderBy(desc(habitCompletions.completedAt))
    
    const totalCompletions = allCompletions.length
    
    // Calculate mood distribution
    const moodCounts = allCompletions.reduce((acc, completion) => {
      if (completion.mood) {
        acc[completion.mood] = (acc[completion.mood] || 0) + 1
      }
      return acc
    }, {} as Record<string, number>)
    
    // Get recent streak info
    const recentCompletions = allCompletions.slice(0, 7) // Last 7 days
    const recentStreak = recentCompletions.length
    
    return c.json({
      success: true,
      data: {
        habit: {
          id: habit.id,
          name: habit.name,
          currentStreak: habit.currentStreak,
          longestStreak: habit.longestStreak,
          experienceReward: habit.experienceReward
        },
        stats: {
          totalCompletions,
          recentStreak,
          moodDistribution: moodCounts,
          averageCompletionsPerWeek: Math.round((totalCompletions / Math.max(1, Math.ceil((Date.now() - new Date(habit.createdAt).getTime()) / (7 * 24 * 60 * 60 * 1000)))) * 100) / 100
        }
      }
    })
  } catch (error) {
    console.error('Error getting habit stats:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export { habitRoute }
