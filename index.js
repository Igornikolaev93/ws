// Импорт необходимых модулей
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");
const nunjucks = require("nunjucks");
const { nanoid } = require("nanoid");
const cookieParser = require("cookie-parser");
const pool = require("./db");
const bcrypt = require("bcrypt");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

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
  const sessionId = req.cookies.sessionId;
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
          username: result.rows[0].username,
        };
        await pool.query(
          "UPDATE sessions SET expires_at = NOW() + INTERVAL '24 hours' WHERE session_id = $1",
          [sessionId]
        );
      }
    } catch (error) {
      console.error("Session validation error:", error);
    }
  }
  next();
});

const formatTimer = (dbTimer, userId) => {
  const timer = {
    id: dbTimer.id,
    description: dbTimer.description,
    start: dbTimer.start_time.getTime(),
    isActive: dbTimer.is_active,
    userId: userId,
    createdAt: dbTimer.created_at.getTime(),
  };
  if (dbTimer.end_time) {
    timer.end = dbTimer.end_time.getTime();
    timer.duration = timer.end - timer.start;
  }
  if (dbTimer.is_active) {
    timer.progress = Date.now() - timer.start;
  }
  return timer;
};

const getTimers = async (userId) => {
  const result = await pool.query(
    `SELECT id, description, start_time, end_time, is_active, created_at
     FROM timers
     WHERE user_id = $1
     ORDER BY created_at DESC, start_time DESC`,
    [userId]
  );
  return result.rows.map((row) => formatTimer(row, userId));
};

const broadcastToUser = (userId, message) => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.user._id === userId) {
      client.send(JSON.stringify(message));
    }
  });
};

app.get("/login", (req, res) => {
  if (req.user) return res.redirect("/");
  res.render("login", {
    authError: req.query.authError,
  });
});

app.get("/signup", (req, res) => {
  if (req.user) return res.redirect("/");
  res.render("signup", {
    authError: req.query.authError,
  });
});

app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 3) {
    return res.redirect(
      "/signup?authError=Username and password must be at least 3 characters long"
    );
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.redirect(
      "/signup?authError=Username can only contain letters, numbers and underscores"
    );
  }
  try {
    const existingUser = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    if (existingUser.rows.length > 0) {
      return res.redirect("/signup?authError=User already exists");
    }
    const hashedPassword = await hashPassword(password);
    const newUser = await pool.query(
      "INSERT INTO users (username, password, created_at) VALUES ($1, $2, NOW()) RETURNING id, username",
      [username, hashedPassword]
    );
    const sessionId = nanoid();
    await pool.query(
      "INSERT INTO sessions (session_id, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '24 hours')",
      [sessionId, newUser.rows[0].id]
    );
    res.cookie("sessionId", sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000,
    });
    res.redirect("/");
  } catch (error) {
    console.error("Signup error:", error);
    res.redirect("/signup?authError=Registration failed");
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.redirect("/login?authError=Wrong username or password");
  }
  try {
    const userResult = await pool.query(
      "SELECT id, username, password FROM users WHERE username = $1",
      [username]
    );
    if (userResult.rows.length === 0) {
      return res.redirect("/login?authError=Wrong username or password");
    }
    const user = userResult.rows[0];
    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
      return res.redirect("/login?authError=Wrong username or password");
    }
    const sessionId = nanoid();
    await pool.query(
      "INSERT INTO sessions (session_id, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '24 hours')",
      [sessionId, user.id]
    );
    res.cookie("sessionId", sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000,
    });
    res.redirect("/");
  } catch (error) {
    console.error("Login error:", error);
    res.redirect("/login?authError=Login failed");
  }
});

app.post("/logout", async (req, res) => {
  const sessionId = req.cookies.sessionId;
  if (sessionId) {
    try {
      await pool.query("DELETE FROM sessions WHERE session_id = $1", [
        sessionId,
      ]);
    } catch (error) {
      console.error("Logout error:", error);
    }
    res.clearCookie("sessionId");
  }
  res.redirect("/login");
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
      "INSERT INTO timers (description, start_time, is_active, user_id, created_at) VALUES ($1, NOW(), true, $2, NOW()) RETURNING *",
      [description.trim(), req.user._id]
    );
    res.status(201).json(formatTimer(result.rows[0], req.user._id));
    const allTimers = await getTimers(req.user._id);
    broadcastToUser(req.user._id, { type: "all_timers", payload: allTimers });
  } catch (error) {
    console.error("Create timer error:", error);
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
       RETURNING *`,
      [id, req.user._id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Timer not found or already stopped" });
    }
    res.json(formatTimer(result.rows[0], req.user._id));
    const allTimers = await getTimers(req.user._id);
    broadcastToUser(req.user._id, { type: "all_timers", payload: allTimers });
  } catch (error) {
    console.error("Stop timer error:", error);
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
      "DELETE FROM timers WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, req.user._id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Timer not found" });
    }
    res.json({ message: "Timer deleted successfully" });
    const allTimers = await getTimers(req.user._id);
    broadcastToUser(req.user._id, { type: "all_timers", payload: allTimers });
  } catch (error) {
    console.error("Delete timer error:", error);
    res.status(500).json({ error: "Failed to delete timer" });
  }
});

app.get("/api/user", (req, res) => {
  if (req.user) {
    res.json({ user: req.user });
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
});

app.get("/", (req, res) => {
  res.render("index", {
    user: req.user,
    authError: req.query.authError,
  });
});

server.on("upgrade", async function upgrade(request, socket, head) {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname === "/ws") {
    const cookies = request.headers.cookie;
    if (!cookies) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionIdCookie = cookies.split(";").find((c) => c.trim().startsWith("sessionId="));
    if (!sessionIdCookie) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionId = sessionIdCookie.split("=")[1];
    try {
      const result = await pool.query(
        `SELECT s.user_id, u.id, u.username
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.session_id = $1 AND s.expires_at > NOW()`,
        [sessionId]
      );
      if (result.rows.length > 0) {
        const user = {
          _id: result.rows[0].id,
          username: result.rows[0].username,
        };
        wss.handleUpgrade(request, socket, head, function done(ws) {
          ws.user = user;
          wss.emit("connection", ws, request);
        });
      } else {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      }
    } catch (error) {
      console.error("WebSocket authentication error:", error);
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    }
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (ws, req) => {
  console.log("Client connected:", ws.user.username);
  try {
    const allTimers = await getTimers(ws.user._id);
    ws.send(JSON.stringify({ type: "all_timers", payload: allTimers }));
  } catch (error) {
    console.error("Failed to fetch initial timers:", error);
  }
  ws.on("close", () => {
    console.log("Client disconnected:", ws.user.username);
  });
});

setInterval(async () => {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        const result = await pool.query(
          `SELECT id, description, start_time, is_active, created_at
           FROM timers
           WHERE user_id = $1 AND is_active = true
           ORDER BY created_at DESC, start_time DESC`,
          [client.user._id]
        );
        const activeTimers = result.rows.map((row) => formatTimer(row, client.user._id));
        client.send(JSON.stringify({ type: "active_timers", payload: activeTimers }));
      } catch (error) {
        console.error(`Failed to send active timers to ${client.user.username}:`, error);
      }
    }
  }
}, 1000);

const cleanupExpiredSessions = async () => {
  try {
    await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
  } catch (error) {
    console.error("Session cleanup error:", error);
  }
};
setInterval(cleanupExpiredSessions, 24 * 60 * 60 * 1000);

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  cleanupExpiredSessions();
});
