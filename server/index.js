// Импорт необходимых модулей
const express = require("express");
const http = require('http');
const { WebSocketServer } = require('ws');
const nunjucks = require("nunjucks");
const { nanoid } = require("nanoid");
const cookieParser = require("cookie-parser");
const pool = require("./db");
const bcrypt = require("bcrypt");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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

const hashPassword = async (password) => {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
};

const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

app.use(async (req, res, next) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId || req.cookies.sessionId;

  if (sessionId) {
    try {
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

app.get('/', (req, res) => {
  res.render('index');
});

const getTimers = async (userId, onlyActive = false) => {
  let query = `SELECT id, description, start_time, end_time, is_active, created_at 
               FROM timers 
               WHERE user_id = $1`;
  if (onlyActive) {
    query += " AND is_active = true";
  }
  query += " ORDER BY created_at DESC, start_time DESC";

  const result = await pool.query(query, [userId]);
  return result.rows.map(row => {
    const timer = {
      id: row.id,
      description: row.description,
      start: row.start_time.getTime(),
      isActive: row.is_active,
      userId: userId,
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
};

wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'auth') {
        const sessionId = data.sessionId;
        if (sessionId) {
          const result = await pool.query(
            `SELECT s.user_id, u.id, u.username
             FROM sessions s
             JOIN users u ON s.user_id = u.id
             WHERE s.session_id = $1 AND s.expires_at > NOW()`,
            [sessionId]
          );

          if (result.rows.length > 0) {
            ws.user = {
              _id: result.rows[0].user_id
            };
            const timers = await getTimers(ws.user._id);
            ws.send(JSON.stringify({ type: 'all_timers', payload: timers }));
          } else {
            ws.close();
          }
        } else {
          ws.close();
        }
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
});

setInterval(() => {
  wss.clients.forEach(async (client) => {
    if (client.readyState === client.OPEN && client.user) {
      const activeTimers = await getTimers(client.user._id, true);
      client.send(JSON.stringify({ type: 'active_timers', payload: activeTimers }));
    }
  });
}, 1000);

const broadcastAllTimers = async (userId) => {
  const timers = await getTimers(userId);
  wss.clients.forEach(client => {
    if (client.readyState === client.OPEN && client.user && client.user._id === userId) {
      client.send(JSON.stringify({ type: 'all_timers', payload: timers }));
    }
  });
};

app.get("/login", (req, res) => {
  if (req.user) {
    return res.redirect("/");
  }

  res.render("login", {
    authError: req.query.authError === "true" ? "Wrong username or password" : req.query.authError,
  });
});

app.get("/signup", (req, res) => {
  if (req.user) {
    return res.redirect("/");
  }

  res.render("signup", {
    authError: req.query.authError,
  });
});

app.post("/signup", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  if (username.length < 3 || password.length < 3) {
    return res.status(400).json({ error: "Username and password must be at least 3 characters long" });
  }

  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: "Username can only contain letters, numbers and underscores" });
  }

  try {
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: "User already exists" });
    }

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

    res.json({ sessionId });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  try {
    const userResult = await pool.query(
      'SELECT id, username, password FROM users WHERE username = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const user = userResult.rows[0];

    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const sessionId = nanoid();

    await pool.query(
      'INSERT INTO sessions (session_id, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'24 hours\')',
      [sessionId, user.id]
    );

    res.json({ sessionId });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/logout", async (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId || req.cookies.sessionId;

  if (sessionId) {
    try {
      await pool.query(
        'DELETE FROM sessions WHERE session_id = $1',
        [sessionId]
      );
    } catch (error) {
      console.error('Logout error:', error);
    }
  }

  res.json({});
});

app.get("/api/user", (req, res) => {
  if (req.user) {
    res.json({ user: req.user });
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

app.get("/api/timers", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const timers = await getTimers(req.user._id);
    res.json(timers);
  } catch (error) {
    console.error('Get timers error:', error);
    res.status(500).json({ error: "Failed to get timers" });
  }
});

app.post("/api/timers", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const { description } = req.body;

  if (!description || description.trim().length === 0) {
    return res.status(400).json({ error: "Description is required" });
  }

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

    broadcastAllTimers(req.user._id);
    res.json(newTimer);
  } catch (error) {
    console.error('Create timer error:', error);
    res.status(500).json({ error: "Failed to create timer" });
  }
});

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

    broadcastAllTimers(req.user._id);
    res.json(timer);
  } catch (error) {
    console.error('Stop timer error:', error);
    res.status(500).json({ error: "Failed to stop timer" });
  }
});

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
    
    broadcastAllTimers(req.user._id);
    res.json({ message: "Timer deleted successfully" });
  } catch (error) {
    console.error('Delete timer error:', error);
    res.status(500).json({ error: "Failed to delete timer" });
  }
});

const cleanupExpiredSessions = async () => {
  try {
    await pool.query('DELETE FROM sessions WHERE expires_at <= NOW()');
    console.log('Expired sessions cleaned up');
  } catch (error) {
    console.error('Session cleanup error:', error);
  }
};

setInterval(cleanupExpiredSessions, 24 * 60 * 60 * 1000);

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  cleanupExpiredSessions();
});
