const readline = require('readline');
const axios = require('axios');
const WebSocket = require('ws');
const { Cookie, CookieJar } = require('tough-cookie');
const { default: axiosCookieJarSupport } = require('axios-cookiejar-support');

const API_URL = 'http://localhost:3000';

const jar = new CookieJar();
const client = axios.create({ jar, baseURL: API_URL });
axiosCookieJarSupport(client);

let ws;
let activeTimers = [];
let oldTimers = [];
let user = null;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> '
});

const displayTimers = () => {
  console.log('\\nActive timers:');
  if (activeTimers.length === 0) {
    console.log('No active timers.');
  } else {
    console.table(activeTimers.map(t => ({
      ID: t.id,
      Description: t.description,
      Progress: formatDuration(t.progress || 0),
      Start: formatTime(t.start),
    })));
  }

  console.log('\\nOld timers:');
  if (oldTimers.length === 0) {
    console.log('No old timers.');
  } else {
    console.table(oldTimers.map(t => ({
      ID: t.id,
      Description: t.description,
      Duration: formatDuration(t.duration || 0),
      Start: formatTime(t.start),
      End: formatTime(t.end),
    })));
  }
  console.log();
};

const connectWebSocket = async () => {
  const sessionCookie = await jar.getCookieString(API_URL);
  if (!sessionCookie) {
    console.log("Could not find session cookie for WebSocket connection.");
    return;
  }

  ws = new WebSocket(API_URL.replace(/^http/, 'ws') + '/ws', {
    headers: {
      Cookie: sessionCookie
    }
  });

  ws.on('open', () => {
    console.log('WebSocket connection established.');
    rl.prompt();
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      if (message.type === 'all_timers') {
        activeTimers = message.payload.filter(t => t.isActive);
        oldTimers = message.payload.filter(t => !t.isActive);
      } else if (message.type === 'active_timers') {
        activeTimers = message.payload;
      }
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed.');
    ws = null;
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
};

const commands = {
  signup: async (args) => {
    const [username, password] = args;
    if (!username || !password) {
      console.log('Usage: signup <username> <password>');
      return;
    }
    try {
      await client.post('/signup', { username, password });
      console.log(`User "${username}" signed up. Please login.`);
    } catch (error) {
      console.error('Signup failed:', error.response ? error.response.data : error.message);
    }
  },
  login: async (args) => {
    const [username, password] = args;
    if (!username || !password) {
      console.log('Usage: login <username> <password>');
      return;
    }
    try {
      const response = await client.post('/login', { username, password });
      // The cookie is now in the jar.
      // We need to get the user object to store it.
      const userResponse = await client.get('/api/user');
      user = userResponse.data.user;
      console.log(`Logged in as "${user.username}".`);
      await connectWebSocket();
    } catch (error) {
      user = null;
      console.error('Login failed:', error.response ? error.response.data : error.message);
    }
  },
  logout: async () => {
    if (!user) {
        console.log("You are not logged in.");
        return;
    }
    try {
      await client.post('/logout');
      console.log('Logged out successfully.');
      user = null;
      if (ws) {
        ws.close();
      }
      activeTimers = [];
      oldTimers = [];
    } catch (error) {
      console.error('Logout failed:', error.response ? error.response.data : error.message);
    }
  },
  start: async (args) => {
    const description = args.join(' ');
    if (!description) {
      console.log('Usage: start <description>');
      return;
    }
    try {
      await client.post('/api/timers', { description });
      console.log(`Timer "${description}" started.`);
      // Data will be updated by websocket, just show current status
      displayTimers();
    } catch (error) {
      console.error('Failed to start timer:', error.response ? error.response.data : error.message);
    }
  },
  stop: async (args) => {
    const [id] = args;
    if (!id) {
      console.log('Usage: stop <id>');
      return;
    }
    try {
      await client.post(`/api/timers/${id}/stop`);
      console.log(`Timer with ID "${id}" stopped.`);
      // Data will be updated by websocket, just show current status
      displayTimers();
    } catch (error) {
      console.error('Failed to stop timer:', error.response ? error.response.data : error.message);
    }
  },
  status: () => {
    displayTimers();
  },
  exit: () => {
    if (ws) {
      ws.close();
    }
    rl.close();
    process.exit(0);
  }
};

rl.on('line', async (line) => {
  const [command, ...args] = line.trim().split(/\s+/);
  const handler = commands[command];

  if (handler) {
    const needsAuth = !['login', 'signup', 'exit'].includes(command);
    if (needsAuth && !user) {
      console.log('You need to login first.');
    } else {
      await handler(args);
    }
  } else if(command) {
    console.log(`Unknown command: "${command}"`);
  }
  rl.prompt();
});

rl.on('close', () => {
  console.log('\\nGoodbye!');
  process.exit(0);
});

function formatTime(ts) {
    if (!ts) return 'N/A';
    return new Date(ts).toTimeString().split(' ')[0];
}

function formatDuration(d) {
    if (d === null || d === undefined) return 'N/A';
    d = Math.floor(d / 1000);
    const s = d % 60;
    d = Math.floor(d / 60);
    const m = d % 60;
    const h = Math.floor(d / 60);
    return [h > 0 ? h : null, m, s]
      .filter((x) => x !== null)
      .map((x) => (x < 10 ? '0' : '') + x)
      .join(':');
}


console.log('Welcome to the interactive timer CLI.');
console.log('Available commands: signup, login, logout, start, stop, status, exit');
rl.prompt();
