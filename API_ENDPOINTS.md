# Piru API Endpoints

This document describes all the API endpoints for the Piru habits and nofap gamification app.

## Authentication

All endpoints except `/api/auth/*` require authentication via Bearer token in the Authorization header.

**For React Native apps:**
- The JWT token is received in the redirect URL after Google OAuth
- Store the token securely in your app (e.g., using AsyncStorage or SecureStore)
- Include the token in all API requests as: `Authorization: Bearer <your-jwt-token>`

### Google OAuth Flow

- `GET /api/auth/google` - Initiate Google OAuth flow
- `GET /api/auth/google/callback` - Google OAuth callback (handles token creation)

## User Endpoints

### Profile Management
- `GET /api/user/profile` - Get user profile and settings
- `PUT /api/user/profile` - Update user profile
  ```json
  {
    "name": "string (optional)",
    "avatar": "url (optional)",
    "skills": "object (optional)"
  }
  ```

### Settings
- `PUT /api/user/settings` - Update user settings
  ```json
  {
    "notificationsEnabled": "boolean (optional)",
    "reminderTime": "HH:MM format (optional)",
    "language": "2-letter code (optional)"
  }
  ```

### Gamification
- `POST /api/user/experience` - Add experience points
  ```json
  {
    "experience": "number (1-1000)"
  }
  ```
- `PUT /api/user/streak` - Update user streak
  ```json
  {
    "currentStreak": "number (min 0)"
  }
  ```

### Statistics
- `GET /api/user/stats` - Get user statistics and progress

## Habit Endpoints

### CRUD Operations
- `GET /api/habits` - Get all user habits
- `GET /api/habits/:id` - Get specific habit with recent completions
- `POST /api/habits` - Create new habit
  ```json
  {
    "name": "string (required)",
    "description": "string (optional)",
    "targetDays": "number (1-365, default: 7)",
    "experienceReward": "number (1-100, default: 10)",
    "reminderTime": "HH:MM format (default: 09:00)"
  }
  ```
- `PUT /api/habits/:id` - Update habit
  ```json
  {
    "name": "string (optional)",
    "description": "string (optional)",
    "targetDays": "number (1-365, optional)",
    "experienceReward": "number (1-100, optional)",
    "reminderTime": "HH:MM format (optional)"
  }
  ```
- `DELETE /api/habits/:id` - Delete habit (also deletes all completions)

### Habit Completion
- `POST /api/habits/:id/complete` - Mark habit as completed for today
  ```json
  {
    "notes": "string (optional)",
    "mood": "great|good|okay|bad (optional)"
  }
  ```

### Habit Data
- `GET /api/habits/:id/completions` - Get habit completions
  - Query params: `limit` (default: 30), `offset` (default: 0)
- `GET /api/habits/:id/stats` - Get habit statistics

## Response Format

All endpoints return JSON responses with the following structure:

### Success Response
```json
{
  "success": true,
  "data": { ... },
  "message": "string (optional)"
}
```

### Error Response
```json
{
  "error": "error message"
}
```

## Authentication

Include the JWT token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

## Database Schema

The app uses the following main tables:
- `users` - User profiles and gamification data
- `user_settings` - User preferences
- `habits` - User habits
- `habit_completions` - Daily habit completions

## Gamification Features

- **Experience System**: Users gain XP for completing habits
- **Leveling**: Users level up when they reach experience thresholds
- **Streaks**: Track current and longest streaks for habits and overall
- **Mood Tracking**: Users can log their mood when completing habits
- **Statistics**: Comprehensive stats for habits and user progress
