import { mysqlTable, varchar, int, timestamp, text, boolean, json } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
    id: int("id").primaryKey().autoincrement(),
    email: varchar("email", { length: 255 }).unique().notNull(),
    name: varchar("name", { length: 255 }),
    googleId: varchar('google_id', { length: 255 }).unique().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    level: int("level").default(1),
    experience: int("experience").default(0),
    experienceToNext: int("experience_to_next").default(100),
    currentStreak: int("current_streak").default(0),
    longestStreak: int("longest_streak").default(0),
    avatar: varchar("avatar", { length: 255 }),
    skills: json("skills"),
});

export const habits = mysqlTable("habits", {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id").notNull().references(() => users.id),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    targetDays: int("target_days").default(7),
    currentStreak: int("current_streak").default(0),
    longestStreak: int("longest_streak").default(0),
    experienceReward: int("experience_reward").default(10),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    reminderTime: varchar("reminder_time", { length: 10 }).default("09:00"),
});


export const habitCompletions = mysqlTable("habit_completions", {
    id: int("id").primaryKey().autoincrement(),
    habitId: int("habit_id").notNull().references(() => habits.id),
    userId: int("user_id").notNull().references(() => users.id),
    completedAt: timestamp("completed_at").defaultNow().notNull(),
    notes: text("notes"),
    mood: varchar("mood", { length: 20 }), // great, good, okay, bad
});

export const userSettings = mysqlTable("user_settings", {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id").notNull().unique().references(() => users.id),
    notificationsEnabled: boolean("notifications_enabled").default(true),
    reminderTime: varchar("reminder_time", { length: 10 }).default("09:00"),
    language: varchar("language", { length: 10 }).default("es"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
