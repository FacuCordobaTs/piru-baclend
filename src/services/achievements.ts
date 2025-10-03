import { and, desc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { achievements as achievementsTable, habitCompletions, habits, users } from '../db/schema'

export type AchievementTier = 'Bronce' | 'Plata' | 'Oro'
export type AchievementCategory = 'physical' | 'mental' | 'discipline' | 'special'

export interface AchievementDefinition {
  id: string
  name: string
  desc: string
  points: number
  tier: AchievementTier
  category: AchievementCategory
}

export interface UserSnapshot {
  id: number
  level: number
  longestStreak: number
  globalHabitsStreak: number
  physicalPoints: number
  mentalPoints: number
  spiritualPoints: number
  disciplinePoints: number
  socialPoints: number
}

export const ACHIEVEMENTS_CATALOG: AchievementDefinition[] = [
  // Especiales (progresión general)
  { id: 'first_completion', name: 'Primer Paso', desc: 'Completa tu primer hábito', points: 20, tier: 'Bronce', category: 'special' },
  { id: 'completions_50', name: 'Aprendiz Constante', desc: 'Completa 50 hábitos en total', points: 40, tier: 'Plata', category: 'special' },
  { id: 'completions_200', name: 'Maestro de la Rutina', desc: 'Completa 200 hábitos en total', points: 80, tier: 'Oro', category: 'special' },
  { id: 'level_2', name: 'Novato', desc: 'Alcanza el nivel 2', points: 20, tier: 'Bronce', category: 'special' },
  { id: 'level_5', name: 'Veterano', desc: 'Alcanza el nivel 5', points: 40, tier: 'Plata', category: 'special' },
  { id: 'level_10', name: 'Héroe', desc: 'Alcanza el nivel 10', points: 80, tier: 'Oro', category: 'special' },
  // Disciplina (rachas)
  { id: 'global_streak_7', name: 'Racha de 7', desc: 'Completa hábitos 7 días seguidos', points: 30, tier: 'Bronce', category: 'discipline' },
  { id: 'global_streak_30', name: 'Hierro 30', desc: 'Racha global de 30 días', points: 60, tier: 'Plata', category: 'discipline' },
  { id: 'global_streak_90', name: 'Imparable 90', desc: 'Racha global de 90 días', points: 120, tier: 'Oro', category: 'discipline' },
  { id: 'habit_streak_7', name: 'Fiel a un Hábito', desc: 'Racha de 7 días en un hábito', points: 30, tier: 'Bronce', category: 'discipline' },
  { id: 'habit_streak_30', name: 'Disciplina de Acero', desc: 'Racha de 30 días en un hábito', points: 60, tier: 'Plata', category: 'discipline' },
  // NoFap (relapse-based)
  { id: 'nofap_14', name: 'Honor 14', desc: '14 días NoFap', points: 50, tier: 'Plata', category: 'special' },
  { id: 'nofap_30', name: 'Honor 30', desc: '30 días NoFap', points: 90, tier: 'Oro', category: 'special' },
  // Físico / Mental (puntos de atributo)
  { id: 'physical_50', name: 'Cuerpo Forjado', desc: '50 pts en Físico', points: 40, tier: 'Plata', category: 'physical' },
  { id: 'physical_100', name: 'Campeón Físico', desc: '100 pts en Físico', points: 80, tier: 'Oro', category: 'physical' },
  { id: 'mental_50', name: 'Mente Firme', desc: '50 pts en Mental', points: 40, tier: 'Plata', category: 'mental' },
  { id: 'mental_100', name: 'Sabio', desc: '100 pts en Mental', points: 80, tier: 'Oro', category: 'mental' },
  { id: 'discipline_pts_50', name: 'Voluntad de Hierro', desc: '50 pts en Disciplina', points: 40, tier: 'Plata', category: 'discipline' },
  { id: 'discipline_pts_100', name: 'Señor de la Voluntad', desc: '100 pts en Disciplina', points: 80, tier: 'Oro', category: 'discipline' },
]

function getCategoryTitle(category: AchievementCategory): string {
  switch (category) {
    case 'physical': return 'Físico'
    case 'mental': return 'Mental'
    case 'discipline': return 'Disciplina'
    default: return 'Especiales'
  }
}

async function getTotals(db: ReturnType<typeof drizzle>, userId: number) {
  const comps = await db.select().from(habitCompletions).where(eq(habitCompletions.userId, userId))
  const userHabits = await db.select().from(habits).where(eq(habits.userId, userId))

  const totalCompletions = comps.length
  const maxHabitCurrentStreak = userHabits.reduce((max, h) => Math.max(max, h.currentStreak || 0), 0)
  return { totalCompletions, maxHabitCurrentStreak }
}

function isAchieved(defId: string, user: UserSnapshot, totals: { totalCompletions: number, maxHabitCurrentStreak: number }): boolean {
  switch (defId) {
    case 'first_completion': return totals.totalCompletions >= 1
    case 'completions_50': return totals.totalCompletions >= 50
    case 'completions_200': return totals.totalCompletions >= 200
    case 'level_2': return user.level >= 2
    case 'level_5': return user.level >= 5
    case 'level_10': return user.level >= 10
    case 'global_streak_7': return user.globalHabitsStreak >= 7
    case 'global_streak_30': return user.globalHabitsStreak >= 30
    case 'global_streak_90': return user.globalHabitsStreak >= 90
    case 'habit_streak_7': return totals.maxHabitCurrentStreak >= 7
    case 'habit_streak_30': return totals.maxHabitCurrentStreak >= 30
    case 'nofap_14': return user.longestStreak >= 14
    case 'nofap_30': return user.longestStreak >= 30
    case 'physical_50': return user.physicalPoints >= 50
    case 'physical_100': return user.physicalPoints >= 100
    case 'mental_50': return user.mentalPoints >= 50
    case 'mental_100': return user.mentalPoints >= 100
    case 'discipline_pts_50': return user.disciplinePoints >= 50
    case 'discipline_pts_100': return user.disciplinePoints >= 100
    default: return false
  }
}

export async function listAchievementsWithStatus(userId: number) {
  const db = drizzle(pool)
  const unlocked = await db.select().from(achievementsTable).where(eq(achievementsTable.userId, userId))
  const unlockedSet = new Set(unlocked.map(a => a.achievementId))

  const categories = ['physical','mental','discipline','special'] as AchievementCategory[]
  const result = categories.map(cat => ({
    id: cat,
    title: getCategoryTitle(cat),
    items: ACHIEVEMENTS_CATALOG.filter(a => a.category === cat).map(def => ({
      id: def.id,
      name: def.name,
      desc: def.desc,
      points: def.points,
      tier: def.tier,
      completed: unlockedSet.has(def.id),
      completedAt: unlocked.find(u => u.achievementId === def.id)?.completedAt || null,
    }))
  }))

  return { categories }
}

export async function checkAndUnlockOnCompletion(userAfter: UserSnapshot): Promise<{ unlocked: AchievementDefinition[] }> {
  const db = drizzle(pool)
  const { totalCompletions, maxHabitCurrentStreak } = await getTotals(db, userAfter.id)

  const unlockedRows = await db.select().from(achievementsTable).where(eq(achievementsTable.userId, userAfter.id))
  const already = new Set(unlockedRows.map(r => r.achievementId))

  const newlyUnlocked: AchievementDefinition[] = []

  for (const def of ACHIEVEMENTS_CATALOG) {
    if (already.has(def.id)) continue
    if (isAchieved(def.id, userAfter, { totalCompletions, maxHabitCurrentStreak })) {
      newlyUnlocked.push(def)
    }
  }

  if (newlyUnlocked.length > 0) {
    for (const def of newlyUnlocked) {
      await db.insert(achievementsTable).values({
        userId: userAfter.id,
        achievementId: def.id,
      })
    }
  }

  return { unlocked: newlyUnlocked }
}


