const os = require("os");
const path = require("path");
const fs = require("fs");
const inquirer = require("inquirer");
const axios = require("axios");
const WebSocket = require("ws");
const chalk = require("chalk");
require("dotenv").config();

const homeDir = os.homedir();
const isWindows = os.type().match(/windows/i);
const sessionFileName = path.join(homeDir, `${isWindows ? "_" : "."}sb-timers-session`);

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const WS_URL = SERVER_URL.replace(/^http/, "ws");

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

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

function printTimers(timers, active = true) {
  if (timers.length === 0) {
    console.log(chalk.yellow(`No ${active ? "active" : "completed"} timers.`));
    return;
  }

  console.log(chalk.bold.blue(`${active ? "Active" : "Completed"} timers:`));
  console.log(
    chalk.bold.white("ID".padEnd(15) + "Description".padEnd(40) + "Duration")
  );
  console.log(chalk.bold.white("-".repeat(70)));

  timers.forEach((timer) => {
    const duration = active
      ? formatDuration(Date.now() - new Date(timer.start).getTime())
      : formatDuration(timer.duration);

    console.log(
      timer.id.padEnd(15) +
      (timer.description.length > 35
        ? timer.description.substring(0, 32) + "..."
        : timer.description.padEnd(40)) +
      chalk.green(duration)
    );
  });
}

async function connectWebSocket() {
  if (!sessionId) return;

  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "auth", sessionId }));
  });

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === "all_timers") {
        activeTimers = data.payload.filter((t) => t.isActive);
        oldTimers = data.payload.filter((t) => !t.isActive);
      } else if (data.type === "active_timers") {
        activeTimers = data.payload;
      }
    } catch (error) {
      console.error(chalk.red("Error processing WebSocket message:"), error);
    }
  });

  ws.on("close", () => {
    console.log(chalk.yellow("WebSocket connection closed."));
    ws = null;
  });

  ws.on("error", (error) => {
    console.error(chalk.red("WebSocket error:"), error);
  });
}

async function makeRequest(method, endpoint, data = null, params = {}) {
  try {
    const config = {
      method,
      url: `${SERVER_URL}${endpoint}`,
      headers: {
        "Content-Type": "application/json",
        ...(sessionId && { "x-session-id": sessionId }),
      },
      params: sessionId ? { sessionId, ...params } : params,
      ...(data && { data }),
    };

    const response = await axios(config);
    return response.data;
  } catch (error) {
    if (error.response) {
      console.error(
        chalk.red(`Server error (${error.response.status}):`),
        error.response.data.error || error.response.data
      );
    } else if (error.request) {
      console.error(chalk.red("Network error:"), error.message);
    } else {
      console.error(chalk.red("Request error:"), error.message);
    }
    return null;
  }
}

async function mainLoop() {
  readSessionId();
  if (sessionId) {
    await connectWebSocket();
  }

  while (true) {
    const { command } = await inquirer.prompt([
      {
        type: "list",
        name: "command",
        message: "Choose a command:",
        choices: sessionId
          ? ["status", "start", "stop", "logout", "exit"]
          : ["login", "signup", "exit"],
      },
    ]);

    if (command === "exit") {
      if (ws) ws.close();
      console.log(chalk.blue("Goodbye!"));
      break;
    }

    await handleCommand(command);
    console.log('\n');
  }
}

async function handleCommand(command) {
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
      await status();
      break;
  }
}

async function signup() {
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "username",
      message: "Username:",
      validate: (input) => input.length >= 3 || "Username must be at least 3 characters long",
    },
    {
      type: "password",
      name: "password",
      message: "Password:",
      mask: "*",
      validate: (input) => input.length >= 3 || "Password must be at least 3 characters long",
    },
  ]);

  const result = await makeRequest("POST", "/signup", answers);
  if (result && result.sessionId) {
    saveSessionId(result.sessionId);
    console.log(chalk.green("Signed up and logged in successfully!"));
    await connectWebSocket();
  }
}

async function login() {
  const answers = await inquirer.prompt([
    { type: "input", name: "username", message: "Username:" },
    { type: "password", name: "password", message: "Password:", mask: "*" },
  ]);

  const result = await makeRequest("POST", "/login", answers);
  if (result && result.sessionId) {
    saveSessionId(result.sessionId);
    console.log(chalk.green("Logged in successfully!"));
    await connectWebSocket();
  } else {
    console.log(chalk.red("Login failed. Please check your credentials."));
  }
}

async function logout() {
  await makeRequest("POST", "/logout");
  deleteSessionFile();
  if (ws) ws.close();
  activeTimers = [];
  oldTimers = [];
  console.log(chalk.green("Logged out successfully!"));
}

async function startTimer() {
  const { description } = await inquirer.prompt([
    {
      type: "input",
      name: "description",
      message: "Timer description:",
      validate: (input) => input.trim().length > 0 || "Description cannot be empty",
    },
  ]);

  await makeRequest("POST", "/api/timers", { description });
}

async function stopTimer() {
  if (activeTimers.length === 0) {
    console.log(chalk.yellow("No active timers to stop."));
    return;
  }

  const { timerId } = await inquirer.prompt([
    {
      type: "list",
      name: "timerId",
      message: "Choose a timer to stop:",
      choices: activeTimers.map((t) => ({ name: `${t.description} (${t.id})`, value: t.id })),
    },
  ]);

  await makeRequest("POST", `/api/timers/${timerId}/stop`);
}

async function status() {
  const { scope } = await inquirer.prompt([
    {
      type: "list",
      name: "scope",
      message: "Which timers to show?",
      choices: ["active", "old"],
    },
  ]);

  if (scope === "active") {
    printTimers(activeTimers, true);
  } else {
    printTimers(oldTimers, false);
  }
}

if (require.main === module) {
  mainLoop();
}
