-- Migration script to fix the users table schema
-- Run this on your MySQL database to update the table structure

-- Fix the typo in physical_points column name (if it still exists)
-- ALTER TABLE users CHANGE COLUMN phyisical_points physical_points INT DEFAULT 0;

-- Add missing columns if they don't exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS mental_points INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS spiritual_points INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discipline_points INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_points INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_relapse TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS completed_quiz BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referal_code VARCHAR(255);

-- Fix column names to match the schema
ALTER TABLE users CHANGE COLUMN completedQuiz completed_quiz BOOLEAN DEFAULT FALSE;
ALTER TABLE users CHANGE COLUMN referalCode referal_code VARCHAR(255);

-- Make google_id nullable (since we fixed the schema)
ALTER TABLE users MODIFY COLUMN google_id VARCHAR(255) NULL;

-- Update existing records to have default values
UPDATE users SET 
    physical_points = COALESCE(physical_points, 0),
    mental_points = COALESCE(mental_points, 0),
    spiritual_points = COALESCE(spiritual_points, 0),
    discipline_points = COALESCE(discipline_points, 0),
    social_points = COALESCE(social_points, 0),
    level = COALESCE(level, 1),
    age = COALESCE(age, 1),
    experience = COALESCE(experience, 0),
    experience_to_next = COALESCE(experience_to_next, 100),
    longest_streak = COALESCE(longest_streak, 0);

-- Verify the table structure
DESCRIBE users;
