// Импорт необходимых модулей
const express = require("express");
const nunjucks = require("nunjucks");
const { nanoid } = require("nanoid");
const cookieParser = require("cookie-parser");
const pool = require("./db");
const bcrypt = require("bcrypt"); // Добавляем bcrypt для безопасного хеширования

// Создание экземпляра Express приложения
const app = express();

// Настройка Nunjucks шаблонизатора
nunjucks.configure("views", {
  autoescape: true,
  express: app,
  tags: {
    blockStart: "[%",
    blockEnd: "%]",
    variableStart: "[[",
    variableEnd: "]]",
    commentStart: "[#",
    commentEnd: "#]",
  },
});

app.set("view engine", "njk");

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static("public"));

// Функции для работы с паролями (используем bcrypt)
const hashPassword = async (password) => {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
};

const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

// Middleware для проверки аутентификации пользователя
app.use(async (req, res, next) => {
  const sessionId = req.cookies.sessionId;
  
  if (sessionId) {
    try {
      // Обновляем запрос для получения дополнительной информации о пользователе
      const result = await pool.query(
        `SELECT s.user_id, s.expires_at, u.id, u.username 
         FROM sessions s 
         JOIN users u ON s.user_id = u.id 
         WHERE s.session_id = $1 AND s.expires_at > NOW()`,
        [sessionId]
      );
      
      if (result.rows.length > 0) {
        req.user = {
          _id: result.rows[0].id,
          username: result.rows[0].username
        };
        
        // Автоматически продлеваем сессию при активности пользователя
        await pool.query(
          'UPDATE sessions SET expires_at = NOW() + INTERVAL \'24 hours\' WHERE session_id = $1',
          [sessionId]
        );
      }
    } catch (error) {
      console.error('Session validation error:', error);
    }
  }
  
  next();
});

// GET маршрут для страницы логина
app.get("/login", (req, res) => {
  if (req.user) {
    return res.redirect("/");
  }
  
  res.render("login", {
    authError: req.query.authError === "true" ? "Wrong username or password" : req.query.authError,
  });
});

// GET маршрут для страницы регистрации
app.get("/signup", (req, res) => {
  if (req.user) {
    return res.redirect("/");
  }
  
  res.render("signup", {
    authError: req.query.authError,
  });
});

// POST маршрут для обработки регистрации пользователя
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.redirect("/signup?authError=Username and password are required");
  }
  
  if (username.length < 3 || password.length < 3) {
    return res.redirect("/signup?authError=Username and password must be at least 3 characters long");
  }
  
  // Проверка на допустимые символы в имени пользователя
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.redirect("/signup?authError=Username can only contain letters, numbers and underscores");
  }
  
  try {
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );
    
    if (existingUser.rows.length > 0) {
      return res.redirect("/signup?authError=User already exists");
    }
    
    // Хешируем пароль с помощью bcrypt
    const hashedPassword = await hashPassword(password);
    
    const newUser = await pool.query(
      'INSERT INTO users (username, password, created_at) VALUES ($1, $2, NOW()) RETURNING id, username',
      [username, hashedPassword]
    );
    
    const sessionId = nanoid();
    
    await pool.query(
      'INSERT INTO sessions (session_id, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'24 hours\')',
      [sessionId, newUser.rows[0].id]
    );
    
    res.cookie("sessionId", sessionId, { 
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // Используем secure cookies в production
      maxAge: 24 * 60 * 60 * 1000
    });
    
    res.redirect("/");
  } catch (error) {
    console.error('Signup error:', error);
    res.redirect("/signup?authError=Registration failed");
  }
});

// POST маршрут для обработки аутентификации пользователя
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.redirect("/login?authError=true");
  }
  
  try {
    const userResult = await pool.query(
      'SELECT id, username, password FROM users WHERE username = $1',
      [username]
    );
    
    if (userResult.rows.length === 0) {
      return res.redirect("/login?authError=true");
    }
    
    const user = userResult.rows[0];
    
    // Сравниваем пароль с помощью bcrypt
    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
      return res.redirect("/login?authError=true");
    }
    
    const sessionId = nanoid();
    
    await pool.query(
      'INSERT INTO sessions (session_id, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'24 hours\')',
      [sessionId, user.id]
    );
    
    res.cookie("sessionId", sessionId, { 
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000
    });
    
    res.redirect("/");
  } catch (error) {
    console.error('Login error:', error);
    res.redirect("/login?authError=true");
  }
});

// POST маршрут для выхода из системы
app.post("/logout", async (req, res) => {
  const sessionId = req.cookies.sessionId;
  
  if (sessionId) {
    try {
      await pool.query(
        'DELETE FROM sessions WHERE session_id = $1',
        [sessionId]
      );
    } catch (error) {
      console.error('Logout error:', error);
    }
    
    res.clearCookie("sessionId");
  }
  
  res.redirect("/login");
});

// GET API маршрут для получения информации о текущем пользователе
app.get("/api/user", (req, res) => {
  if (req.user) {
    res.json({ user: req.user });
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

// GET API маршрут для получения всех таймеров пользователя
app.get("/api/timers", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const result = await pool.query(
      `SELECT id, description, start_time, end_time, is_active, created_at 
       FROM timers 
       WHERE user_id = $1 
       ORDER BY created_at DESC, start_time DESC`,
      [req.user._id]
    );
    
    const timers = result.rows.map(row => {
      const timer = {
        id: row.id,
        description: row.description,
        start: row.start_time.getTime(),
        isActive: row.is_active,
        userId: req.user._id,
        createdAt: row.created_at.getTime()
      };
      
      if (row.end_time) {
        timer.end = row.end_time.getTime();
        timer.duration = timer.end - timer.start;
      }
      
      if (row.is_active) {
        timer.progress = Date.now() - timer.start;
      }
      
      return timer;
    });
    
    res.json(timers);
  } catch (error) {
    console.error('Get timers error:', error);
    res.status(500).json({ error: "Failed to get timers" });
  }
});

// POST API маршрут для создания нового таймера
app.post("/api/timers", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const { description } = req.body;
  
  if (!description || description.trim().length === 0) {
    return res.status(400).json({ error: "Description is required" });
  }

  // Ограничение длины описания
  if (description.length > 255) {
    return res.status(400).json({ error: "Description too long" });
  }

  try {
    const result = await pool.query(
      'INSERT INTO timers (description, start_time, is_active, user_id, created_at) VALUES ($1, NOW(), true, $2, NOW()) RETURNING id, description, start_time, is_active, created_at',
      [description.trim(), req.user._id]
    );
    
    const newTimer = {
      id: result.rows[0].id,
      description: result.rows[0].description,
      start: result.rows[0].start_time.getTime(),
      isActive: result.rows[0].is_active,
      userId: req.user._id,
      createdAt: result.rows[0].created_at.getTime()
    };
    
    res.json(newTimer);
  } catch (error) {
    console.error('Create timer error:', error);
    res.status(500).json({ error: "Failed to create timer" });
  }
});

// POST API маршрут для остановки таймера по ID
app.post("/api/timers/:id/stop", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE timers 
       SET end_time = NOW(), is_active = false 
       WHERE id = $1 AND user_id = $2 AND is_active = true 
       RETURNING id, description, start_time, end_time, is_active`,
      [id, req.user._id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Timer not found or already stopped" });
    }

    const row = result.rows[0];
    const timer = {
      id: row.id,
      description: row.description,
      start: row.start_time.getTime(),
      end: row.end_time.getTime(),
      duration: row.end_time.getTime() - row.start_time.getTime(),
      isActive: row.is_active,
      userId: req.user._id
    };

    res.json(timer);
  } catch (error) {
    console.error('Stop timer error:', error);
    res.status(500).json({ error: "Failed to stop timer" });
  }
});

// DELETE API маршрут для удаления таймера по ID
app.delete("/api/timers/:id", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const { id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM timers WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user._id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Timer not found" });
    }

    res.json({ message: "Timer deleted successfully" });
  } catch (error) {
    console.error('Delete timer error:', error);
    res.status(500).json({ error: "Failed to delete timer" });
  }
});

// GET маршрут для главной страницы приложения
app.get("/", (req, res) => {
  res.render("index", {
    user: req.user,
    authError: req.query.authError === "true" ? "Wrong username or password" : req.query.authError,
  });
});

// Очистка устаревших сессий (можно запускать по cron)
const cleanupExpiredSessions = async () => {
  try {
    await pool.query('DELETE FROM sessions WHERE expires_at <= NOW()');
    console.log('Expired sessions cleaned up');
  } catch (error) {
    console.error('Session cleanup error:', error);
  }
};

// Запускаем очистку каждые 24 часа
setInterval(cleanupExpiredSessions, 24 * 60 * 60 * 1000);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  // Первоначальная очистка при запуске
  cleanupExpiredSessions();
});