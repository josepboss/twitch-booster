# Twitch Booster

Twitch follower automation via SMMCost API. Express backend + plain HTML frontend.

## Deploy on VPS

### 1. Clone & install
```bash
cd /var/www
git clone https://github.com/josepboss/twitch-booster
cd twitch-booster
npm install
```

### 2. Start with PM2
```bash
pm2 start ecosystem.config.js
pm2 save
```

### 3. Nginx config
```nginx
server {
    listen 80;
    server_name booster.itspanel.com;

    location / {
        proxy_pass http://localhost:3080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        # Important for SSE (live log streaming)
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/booster /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d booster.itspanel.com
```

### 4. Update deploy
```bash
cd /var/www/twitch-booster && git pull && pm2 restart twitch-booster
```

## Ports
- App: 3080
- History stored in: `history.db` (SQLite, auto-created)
