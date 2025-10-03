import { mysqlTable, varchar, int, timestamp, boolean } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
    id: int("id").primaryKey().autoincrement(),
    email: varchar("email", { length: 255 }).unique().notNull(),
    name: varchar("name", { length: 255 }),
    googleId: varchar('google_id', { length: 255 }).unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    level: int("level").default(1),
    age: int("age").default(1),
    experience: int("experience").default(0),
    experienceToNext: int("experience_to_next").default(100),
    currentStreak: int("current_streak").default(0),
    longestStreak: int("longest_streak").default(0),
    avatar: varchar("avatar", { length: 255 }),
    physicalPoints: int("physical_points").default(0),
    mentalPoints: int("mental_points").default(0),
    spiritualPoints: int("spiritual_points").default(0),
    disciplinePoints: int("discipline_points").default(0),
    socialPoints: int("social_points").default(0),
    lastRelapse: timestamp("last_relapse").defaultNow().notNull(),
    completedQuiz: boolean("completed_quiz").default(false),
    referalCode: varchar("referal_code", { length: 255 }),
    globalHabitsStreak: int("global_habits_streak").default(0),
    lastCompletion: timestamp("last_completion").defaultNow().notNull(),
    class: varchar("class", {length: 255}).default("Guerrero"),
});

export const habits = mysqlTable("habits", {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id").notNull().references(() => users.id),
    name: varchar("name", { length: 255 }).notNull(),
    targetMonday: boolean("targetMonday").default(false),
    targetTuesday: boolean("targetTuesday").default(false),
    targetWednesday: boolean("targetWednesday").default(false),
    targetThursday: boolean("targetThursday").default(false),
    targetFriday: boolean("targetFriday").default(false),
    targetSaturday: boolean("targetSaturday").default(false),
    targetSunday: boolean("targetSunday").default(false),
    currentStreak: int("current_streak").default(0),
    longestStreak: int("longest_streak").default(0),
    nextSchedule: timestamp("next_schedule"),
    experienceReward: int("experience_reward").default(10),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    reminderTime: varchar("reminder_time", { length: 10 }).default("09:00"),
    physical: boolean().default(false),
    mental: boolean().default(false),
    spiritual: boolean().default(false),
    discipline: boolean().default(false),
    social: boolean().default(false),
});

export const relapse = mysqlTable("relapse", {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id").notNull().references(() => users.id),
    relapseDate: timestamp("relapse_date").defaultNow().notNull(),
    relapseReason: varchar("relapse_reason", { length: 255 }).notNull(),
});

export const habitCompletions = mysqlTable("habit_completions", {
    id: int("id").primaryKey().autoincrement(),
    habitId: int("habit_id").notNull().references(() => habits.id),
    userId: int("user_id").notNull().references(() => users.id),
    completedAt: timestamp("completed_at").defaultNow().notNull(),
    mood: varchar("mood", {length: 20})
});

export const userSettings = mysqlTable("user_settings", {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id").notNull().unique().references(() => users.id),
    notificationsEnabled: boolean("notifications_enabled").default(true),
    language: varchar("language", { length: 10 }).default("es"),
    createdAt: timestamp("created_at").defaultNow().notNull()
});

export const betaSignups = mysqlTable("beta_signups", {
    id: int("id").primaryKey().autoincrement(),
    email: varchar("email", { length: 255 }).unique().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    status: varchar("status", { length: 20 }).default("pending"), // pending, sent, used
    notes: varchar("notes", { length: 500 })
});

export const achievements = mysqlTable("achievements", {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id").notNull().references(() => users.id),
    achievementId: varchar("achievement_id", { length: 255 }).notNull(),
    completedAt: timestamp("completed_at").defaultNow().notNull(),
});