/*global UIkit, Vue, USER_ID */

(() => {
  const notification = (config) =>
    UIkit.notification({
      pos: "top-right",
      timeout: 5000,
      ...config,
    });

  const alert = (message) =>
    notification({
      message,
      status: "danger",
    });

  const info = (message) =>
    notification({
      message,
      status: "success",
    });

  const fetchJson = (...args) =>
    fetch(...args)
      .then((res) =>
        res.ok
          ? res.status !== 204
            ? res.json()
            : null
          : res.text().then((text) => {
              throw new Error(text);
            })
      )
      .catch((err) => {
        alert(err.message);
      });

  new Vue({
    el: "#app",
    data: {
      desc: "",
      activeTimers: [],
      oldTimers: [],
      ws: null,
      userId: USER_ID,
    },
    methods: {
      createTimer() {
        const description = this.desc;
        this.desc = "";
        fetchJson("/api/timers", {
          method: "post",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ description }),
        }).then((newTimer) => {
          if (newTimer) {
            info(`Created new timer "${description}" [${newTimer.id}]`);
          }
        });
      },
      stopTimer(id) {
        fetchJson(`/api/timers/${id}/stop`, {
          method: "post",
        }).then((stoppedTimer) => {
            if(stoppedTimer) {
                info(`Stopped the timer [${id}]`);
            }
        });
      },
      deleteTimer(id) {
        fetchJson(`/api/timers/${id}`, {
          method: 'delete',
        }).then((res) => {
            if(res){
                info(`Deleted the timer [${id}]`);
            }
        });
      },
      formatTime(ts) {
        return new Date(ts).toTimeString().split(" ")[0];
      },
      formatDuration(d) {
        d = Math.floor(d / 1000);
        const s = d % 60;
        d = Math.floor(d / 60);
        const m = d % 60;
        const h = Math.floor(d / 60);
        return [h > 0 ? h : null, m, s]
          .filter((x) => x !== null)
          .map((x) => (x < 10 ? "0" : "") + x)
          .join(":");
      },
      connect() {
        const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');

        socket.addEventListener('open', () => {
          console.log('WebSocket connected');
          this.ws = socket;
        });

        socket.addEventListener('message', (event) => {
          const data = JSON.parse(event.data);

          if (data.type === 'all_timers') {
            this.activeTimers = data.payload.filter(t => t.isActive);
            this.oldTimers = data.payload.filter(t => !t.isActive);
          } else if (data.type === 'active_timers') {
            this.activeTimers = data.payload;
          } else if (data.message) {
            info(data.message);
          }
        });

        socket.addEventListener('close', () => {
          console.log('WebSocket disconnected. Reconnecting...');
          this.ws = null;
          setTimeout(() => {
            this.connect();
          }, 1000);
        });

        socket.addEventListener('error', (error) => {
          console.error('WebSocket Error:', error);
          this.ws = null;
          socket.close();
        });
      }
    },
    created() {
      this.connect();
    },
  });
})();
