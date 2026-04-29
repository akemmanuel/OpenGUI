# Apache reverse proxy for OpenGUI web

Use Apache in front of OpenGUI web when you want HTTPS and simple single-user auth without changing app code.

## Goal

- public URL like `https://gui.example.com`
- Apache handles TLS and Basic Auth
- OpenGUI listens only on `127.0.0.1:4839`
- no direct public access to Bun port

## 1. Run OpenGUI on loopback

Example container env:

```bash
-e HOST=127.0.0.1 \
-e PORT=4839 \
-e OPENGUI_OPENCODE_PORT=48391
```

Keep firewall closed for `4839`.

## 2. Enable Apache modules

```bash
a2enmod proxy proxy_http proxy_wstunnel rewrite headers ssl auth_basic authn_file
systemctl reload apache2
```

## 3. Create password file

```bash
htpasswd -c /etc/apache2/.htpasswd-opengui opengui
```

Rotate later:

```bash
htpasswd /etc/apache2/.htpasswd-opengui opengui
systemctl reload apache2
```

## 4. HTTP vhost

```apache
<VirtualHost *:80>
    ServerName gui.example.com
    Redirect / https://gui.example.com/
</VirtualHost>
```

## 5. HTTPS vhost

```apache
<IfModule mod_ssl.c>
<VirtualHost *:443>
    ServerName gui.example.com

    ProxyPreserveHost On
    ProxyRequests Off
    RequestHeader set X-Forwarded-Proto "https"

    <Location />
        AuthType Basic
        AuthName "OpenGUI"
        AuthUserFile /etc/apache2/.htpasswd-opengui
        Require valid-user
    </Location>

    ProxyPass /api/events ws://127.0.0.1:4839/api/events retry=0
    ProxyPassReverse /api/events ws://127.0.0.1:4839/api/events

    ProxyPass / http://127.0.0.1:4839/
    ProxyPassReverse / http://127.0.0.1:4839/

    SSLCertificateFile /etc/letsencrypt/live/gui.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/gui.example.com/privkey.pem
    Include /etc/letsencrypt/options-ssl-apache.conf
</VirtualHost>
</IfModule>
```

`/api/events` must allow WebSocket upgrades.

## 6. TLS certificate

Example with Certbot:

```bash
certbot certonly --apache -d gui.example.com
systemctl reload apache2
```

## 7. Verify

- unauthenticated request returns `401`
- authenticated request loads app
- `/api/events` upgrades to WebSocket
- direct `http://SERVER-IP:4839` is unreachable from internet

## Security notes

- Basic Auth protects entry, but authenticated user still gets full OpenGUI power.
- In Docker host-control mode, this is near-host-level access.
- Keep strong password.
- Prefer dedicated subdomain.
- Keep `OPENGUI_ALLOWED_ROOTS` narrow.
