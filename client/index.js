const os = require("os");
const path = require("path");
const fs = require("fs");
const inquirer = require("inquirer");
const axios = require("axios");
const WebSocket = require("ws");
require("dotenv").config();

const homeDir = os.homedir();
const isWindows = os.type().match(/windows/i);
const sessionFileName = path.join(homeDir, `${isWindows ? "_" : "."}sb-timers-session`);

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
let sessionId = null;
let ws = null;
let activeTimers = [];
let oldTimers = [];

function saveSessionId(sid) {
  sessionId = sid;
  fs.writeFileSync(sessionFileName, sid, "utf8");
}

function readSessionId() {
  if (fs.existsSync(sessionFileName)) {
    sessionId = fs.readFileSync(sessionFileName, "utf8").trim();
  }
}

function deleteSessionFile() {
  if (fs.existsSync(sessionFileName)) {
    fs.unlinkSync(sessionFileName);
  }
  sessionId = null;
}

async function makeRequest(method, endpoint, data = null) {
  try {
    const config = {
      method,
      url: `${SERVER_URL}${endpoint}`,
      headers: {
        "Content-Type": "application/json",
        ...(sessionId && { "x-session-id": sessionId }),
      },
      ...(data && { data }),
    };
    const response = await axios(config);
    return response.data;
  } catch (error) {
    if (error.response) {
      console.error(`Server error (${error.response.status}):`, error.response.data.error || error.response.data);
    } else {
      console.error("Network error:", error.message);
    }
    return null;
  }
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function connectWebSocket() {
  if (!sessionId) return;
  ws = new WebSocket(`ws://${SERVER_URL.split("//")[1]}`);

  ws.on("open", () => {
    ws.send(JSON.stringify({ sessionId }));
  });

  ws.on("message", (message) => {
    const { type, payload } = JSON.parse(message);
    if (type === "all_timers") {
      activeTimers = payload.filter(t => t.isActive);
      oldTimers = payload.filter(t => !t.isActive);
    } else if (type === "active_timers") {
      activeTimers = payload;
    }
  });

  ws.on("close", () => {
    console.log("WebSocket connection closed");
  });
}

async function signup() {
  const answers = await inquirer.prompt([
    { type: "input", name: "username", message: "Username:" },
    { type: "password", name: "password", message: "Password:", mask: "*" },
  ]);
  const result = await makeRequest("post", "/signup", answers);
  if (result && result.sessionId) {
    saveSessionId(result.sessionId);
    console.log("Signup successful!");
    connectWebSocket();
  } else {
    console.log("Signup failed.");
  }
}

async function login() {
  const answers = await inquirer.prompt([
    { type: "input", name: "username", message: "Username:" },
    { type: "password", name: "password", message: "Password:", mask: "*" },
  ]);
  const result = await makeRequest("post", "/login", answers);
  if (result && result.sessionId) {
    saveSessionId(result.sessionId);
    console.log("Login successful!");
    connectWebSocket();
  } else {
    console.log("Login failed.");
  }
}

async function logout() {
  await makeRequest("post", "/logout");
  deleteSessionFile();
  if (ws) ws.close();
  console.log("Logged out successfully!");
}

async function startTimer() {
  if (!sessionId) {
    console.log("You need to login first");
    return;
  }
  const { description } = await inquirer.prompt([
    { type: "input", name: "description", message: "Description:" },
  ]);
  await makeRequest("post", "/api/timers", { description });
}

async function stopTimer() {
  if (!sessionId) {
    console.log("You need to login first");
    return;
  }
  const { timerId } = await inquirer.prompt([
    {
      type: "list",
      name: "timerId",
      message: "Select a timer to stop:",
      choices: activeTimers.map(t => ({ name: `${t.description} (${formatDuration(Date.now() - t.start)})`, value: t.id }))
    }
  ]);
  await makeRequest("post", `/api/timers/${timerId}/stop`);
}

function status() {
  if (!sessionId) {
    console.log("You need to login first");
    return;
  }
  console.log("\nActive timers:");
  if (activeTimers.length > 0) {
    console.table(activeTimers.map(t => ({ Description: t.description, Duration: formatDuration(Date.now() - t.start) })));
  } else {
    console.log("No active timers.");
  }

  console.log("\nOld timers:");
  if (oldTimers.length > 0) {
    console.table(oldTimers.map(t => ({ Description: t.description, Duration: formatDuration(t.duration) })));
  } else {
    console.log("No old timers.");
  }
}

async function main() {
  readSessionId();
  if (sessionId) {
    connectWebSocket();
  }

  while (true) {
    const { command } = await inquirer.prompt([
      {
        type: "list",
        name: "command",
        message: "What do you want to do?",
        choices: sessionId ? ["status", "start", "stop", "logout", "exit"] : ["login", "signup", "exit"],
      },
    ]);

    switch (command) {
      case "signup":
        await signup();
        break;
      case "login":
        await login();
        break;
      case "logout":
        await logout();
        break;
      case "start":
        await startTimer();
        break;
      case "stop":
        await stopTimer();
        break;
      case "status":
        status();
        break;
      case "exit":
        if (ws) ws.close();
        process.exit(0);
    }
  }
}

main();
