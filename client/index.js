const os = require("os");
const path = require("path");
<<<<<<< HEAD
const fs = require("fs");
const inquirer = require("inquirer");
const axios = require("axios");
require("dotenv").config();
=======
>>>>>>> 4f8fc97de2c596589e266b5560cb42cf166abdfc

const homeDir = os.homedir();
const isWindows = os.type().match(/windows/i);
const sessionFileName = path.join(homeDir, `${isWindows ? "_" : "."}sb-timers-session`);
console.log("File to keep the session ID:", sessionFileName);
<<<<<<< HEAD

// Конфигурация сервера
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";

// Вспомогательные функции для работы с sessionId
function saveSessionId(sessionId) {
  try {
    fs.writeFileSync(sessionFileName, sessionId, "utf8");
    console.log("Session ID saved successfully!");
  } catch (error) {
    console.error("Failed to save session ID:", error.message);
  }
}

function readSessionId() {
  try {
    if (fs.existsSync(sessionFileName)) {
      return fs.readFileSync(sessionFileName, "utf8").trim();
    }
  } catch (error) {
    console.error("Failed to read session ID:", error.message);
  }
  return null;
}

function deleteSessionFile() {
  try {
    if (fs.existsSync(sessionFileName)) {
      fs.unlinkSync(sessionFileName);
      console.log("Session file deleted successfully!");
    }
  } catch (error) {
    console.error("Failed to delete session file:", error.message);
  }
}

// Функция для выполнения запросов с sessionId
async function makeRequest(method, endpoint, data = null, params = {}) {
  try {
    const sessionId = readSessionId();
    if (!sessionId && endpoint !== "/signup" && endpoint !== "/login") {
      console.error("Error: Not authenticated. Please login or signup first.");
      process.exit(1);
    }

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
      console.error(`Server error (${error.response.status}):`, error.response.data.error || error.response.data);
    } else if (error.request) {
      console.error("Network error:", error.message);
    } else {
      console.error("Request error:", error.message);
    }
    process.exit(1);
  }
}

// Функция для форматирования времени
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

// Команды
async function signup() {
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "username",
      message: "Username:",
      validate: (input) => {
        if (!input || input.length < 3) {
          return "Username must be at least 3 characters long";
        }
        if (!/^[a-zA-Z0-9_]+$/.test(input)) {
          return "Username can only contain letters, numbers and underscores";
        }
        return true;
      },
    },
    {
      type: "password",
      name: "password",
      message: "Password:",
      mask: "*",
      validate: (input) => {
        if (!input || input.length < 3) {
          return "Password must be at least 3 characters long";
        }
        return true;
      },
    },
  ]);

  const result = await makeRequest("POST", "/signup", {
    username: answers.username,
    password: answers.password,
  });

  if (result.sessionId) {
    saveSessionId(result.sessionId);
    console.log("Signed up successfully!");
  }
}

async function login() {
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "username",
      message: "Username:",
    },
    {
      type: "password",
      name: "password",
      message: "Password:",
      mask: "*",
    },
  ]);

  const result = await makeRequest("POST", "/login", {
    username: answers.username,
    password: answers.password,
  });

  if (result.sessionId) {
    saveSessionId(result.sessionId);
    console.log("Logged in successfully!");
  }
}

async function logout() {
  await makeRequest("POST", "/logout");
  deleteSessionFile();
  console.log("Logged out successfully!");
}

async function startTimer(description) {
  if (!description) {
    console.error("Error: Description is required for starting a timer");
    console.log('Usage: node index.js start "Your timer description"');
    process.exit(1);
  }

  const result = await makeRequest("POST", "/api/timers", {
    description: description,
  });

  console.log(`Timer started with ID: ${result.id}`);
  console.log(`Description: ${result.description}`);
}

async function stopTimer(timerId) {
  if (!timerId) {
    console.error("Error: Timer ID is required for stopping a timer");
    console.log("Usage: node index.js stop <timer-id>");
    process.exit(1);
  }

  const result = await makeRequest("POST", `/api/timers/${timerId}/stop`);

  console.log(`Timer stopped: ${result.id}`);
  console.log(`Duration: ${formatDuration(result.duration)}`);
}

async function status(args) {
  const timers = await makeRequest("GET", "/api/timers");

  if (args.length === 0) {
    // Вывод активных таймеров
    const activeTimers = timers.filter((timer) => timer.isActive);

    if (activeTimers.length === 0) {
      console.log("No active timers");
      return;
    }

    console.log("Active timers:");
    console.log("ID".padEnd(15) + "Description".padEnd(40) + "Duration");
    console.log("-".repeat(70));

    activeTimers.forEach((timer) => {
      const duration = timer.progress ? formatDuration(timer.progress) : "0s";
      console.log(
        timer.id.padEnd(15) +
          (timer.description.length > 35 ? timer.description.substring(0, 32) + "..." : timer.description.padEnd(40)) +
          duration
      );
    });
  } else if (args[0] === "old") {
    // Вывод завершенных таймеров
    const oldTimers = timers.filter((timer) => !timer.isActive);

    if (oldTimers.length === 0) {
      console.log("No completed timers");
      return;
    }

    console.log("Completed timers:");
    console.log("ID".padEnd(15) + "Description".padEnd(40) + "Duration");
    console.log("-".repeat(70));

    oldTimers.forEach((timer) => {
      const duration = timer.duration ? formatDuration(timer.duration) : "0s";
      console.log(
        timer.id.padEnd(15) +
          (timer.description.length > 35 ? timer.description.substring(0, 32) + "..." : timer.description.padEnd(40)) +
          duration
      );
    });
  } else {
    // Вывод конкретного таймера по ID
    const timerId = args[0];
    const timer = timers.find((t) => t.id == timerId);

    if (!timer) {
      console.error(`Error: Timer with ID "${timerId}" not found`);
      process.exit(1);
    }

    console.log(`Timer ID: ${timer.id}`);
    console.log(`Description: ${timer.description}`);
    console.log(`Status: ${timer.isActive ? "Active" : "Completed"}`);
    console.log(`Start time: ${new Date(timer.start).toLocaleString()}`);

    if (timer.end) {
      console.log(`End time: ${new Date(timer.end).toLocaleString()}`);
      console.log(`Duration: ${formatDuration(timer.duration)}`);
    } else if (timer.isActive) {
      const duration = timer.progress ? formatDuration(timer.progress) : "0s";
      console.log(`Current duration: ${duration}`);
    }
  }
}

// Основная функция
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log("Available commands:");
    console.log("  signup     - Register a new user");
    console.log("  login      - Login with existing user");
    console.log("  logout     - Logout current user");
    console.log("  start      - Start a new timer (requires description)");
    console.log("  stop       - Stop a timer by ID");
    console.log("  status     - Show timer status");
    console.log("\nExamples:");
    console.log("  node index.js signup");
    console.log('  node index.js start "Working on project"');
    console.log("  node index.js stop abc123");
    console.log("  node index.js status");
    console.log("  node index.js status abc123");
    console.log("  node index.js status old");
    process.exit(1);
  }

  try {
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
        await startTimer(args.slice(1).join(" "));
        break;
      case "stop":
        await stopTimer(args[1]);
        break;
      case "status":
        await status(args.slice(1));
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.log("Use without arguments to see available commands.");
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

// Запуск приложения
if (require.main === module) {
  main();
}
=======
>>>>>>> 4f8fc97de2c596589e266b5560cb42cf166abdfc
