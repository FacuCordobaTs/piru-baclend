import { mysqlTable, varchar, int, timestamp, boolean } from "drizzle-orm/mysql-core";

export const user = mysqlTable("user", {
    id: int("id").primaryKey().autoincrement(),
    email: varchar("email", { length: 255 }).unique().notNull(),
    name: varchar("name", { length: 255 }),
    points: int("points").default(0),
    googleId: varchar('google_id', { length: 255 }).unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    currentStreak: int("current_streak").default(0),
    avatarId: int("avatar_id").references(() => profilePicture.id),
    globalHabitsStreak: int("global_habits_streak").default(0),
    lastCompletion: timestamp("last_completion").defaultNow().notNull(),
});

export const dailyQuest = mysqlTable("daily_quest", {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id").notNull().references(() => user.id),
    name: varchar("name", { length: 255 }).notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    targetMonday: boolean("targetMonday").default(false),
    targetTuesday: boolean("targetTuesday").default(false),
    targetWednesday: boolean("targetWednesday").default(false),
    targetThursday: boolean("targetThursday").default(false),
    targetFriday: boolean("targetFriday").default(false),
    targetSaturday: boolean("targetSaturday").default(false),
    targetSunday: boolean("targetSunday").default(false),
    currentStreak: int("current_streak").default(0),
    pointsReward: int("points_reward").default(10),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    reminderTime: varchar("reminder_time", { length: 10 }).default("09:00"),
    expectedDuration: int("expected_duration").default(10),
});


export const dailyQuestCompletion = mysqlTable("daily_quest_completion", {
    id: int("id").primaryKey().autoincrement(),
    dailyQuestId: int("daily_quest_id").notNull().references(() => dailyQuest.id),
    userId: int("user_id").notNull().references(() => user.id),
    completedAt: timestamp("completed_at").defaultNow().notNull(),
    mood: varchar("mood", {length: 20}),
    dayOfTheWeek: int("day_of_the_week").notNull(),
});

export const secondaryQuest = mysqlTable("secondary_quest", {
    id: int("id").primaryKey().autoincrement(),
    name: varchar("name", { length: 255 }).notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    pointsReward: int("points_reward").default(10),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const secondaryQuestCompletion = mysqlTable("secondary_quest_completion", {
    id: int("id").primaryKey().autoincrement(),
    secondaryQuestId: int("secondary_quest_id").notNull().references(() => secondaryQuest.id),
    userId: int("user_id").notNull().references(() => user.id),
    completedAt: timestamp("completed_at").defaultNow().notNull(),
    mood: varchar("mood", {length: 20})
});

export const profilePicture = mysqlTable("profile_picture", {
    id: int("id").primaryKey().autoincrement(),
    name: varchar("name", { length: 255 }).notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    image: varchar("image", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});