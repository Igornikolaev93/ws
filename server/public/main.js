const app = new Vue({
  el: '#app',
  data: {
    activeTimers: [],
    oldTimers: [],
  },
  created() {
    const ws = new WebSocket(`ws://${window.location.host}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ sessionId: window.AUTH_TOKEN }));
    };

    ws.onmessage = (event) => {
      const { type, payload } = JSON.parse(event.data);

      if (type === 'all_timers') {
        this.activeTimers = payload.filter(timer => timer.isActive);
        this.oldTimers = payload.filter(timer => !timer.isActive);
      }

      if (type === 'active_timers') {
        this.activeTimers = payload;
      }
    };
  },
});
