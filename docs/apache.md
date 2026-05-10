# Apache Reverse Proxy

OpenGUI should usually stay bound to localhost when exposed through Apache.

Example OpenGUI process settings:

```bash
HOST=127.0.0.1
PORT=4839
```

Minimal Apache virtual host:

```apache
<VirtualHost *:443>
  ServerName opengui.example.com

  SSLEngine on
  SSLCertificateFile /etc/letsencrypt/live/opengui.example.com/fullchain.pem
  SSLCertificateKeyFile /etc/letsencrypt/live/opengui.example.com/privkey.pem

  ProxyPreserveHost On
  ProxyPass /api/events ws://127.0.0.1:4839/api/events
  ProxyPassReverse /api/events ws://127.0.0.1:4839/api/events
  ProxyPass / http://127.0.0.1:4839/
  ProxyPassReverse / http://127.0.0.1:4839/
</VirtualHost>
```

Add Basic Auth or another access-control layer before exposing a machine that can run local coding-agent CLIs.
