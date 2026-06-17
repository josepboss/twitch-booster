module.exports = {
  apps: [{
    name: "twitch-booster",
    script: "server.js",
    cwd: "/var/www/twitch-booster",
    env: {
      PORT: 3080,
      NODE_ENV: "production"
    },
    restart_delay: 3000,
    max_restarts: 10
  }]
}
