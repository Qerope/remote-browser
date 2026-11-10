# remote-browser

A small self-hosted remote browser. Headless Chromium runs on your server, and you drive it from any browser tab: live view, mouse, keyboard, paste, tabs, address bar. Persistent profile, so logins survive restarts.

About 300 lines, two dependencies (`playwright-core`, `ws`). No container.

## Security model

- **Not exposed to the internet.** The app listens on a unix socket. You reach it through an SSH tunnel, so SSH is the outer lock.
- **Password login** (constant-time compare, 5 failures/minute lockout, random 7-day session cookie, `HttpOnly` + `SameSite=Strict`). WebSocket checks the cookie and the `Origin`.
- **Locked-down service.** Dedicated unprivileged user, Chromium's own sandbox enabled, systemd sandboxing (`ProtectSystem=strict`, `NoNewPrivileges`, no capabilities, memory/task limits).
- **No pivot into your server.** The service cannot open connections to loopback, private ranges, link-local/cloud metadata, or the host's own public IPs, so a page cannot talk to your other local services. Enforced by systemd, not by the app.
- Only `http(s)` URLs can be typed. Downloads are off.

A browser is a large attack surface. Keep Chromium updated (`install.sh` re-run does it), and don't log in to anything you cannot afford to lose on a host you don't trust.

## Install (Ubuntu 22.04+, root)

```sh
git clone https://github.com/Qerope/remote-browser && cd remote-browser
sudo ./deploy/install.sh          # creates user, installs Chromium + deps, starts the service
sudo cat /etc/remote-browser.env  # your generated password
```

Connect from your machine:

```sh
ssh -L 8080:/run/remote-browser/sock you@your-server
# open http://localhost:8080
```

Log out and back in once after install so your user picks up the `rbrowser` group.

## Develop

```sh
npm install
RB_PASSWORD=some-long-password RB_LISTEN=8080 RB_PROFILE=./profile npx playwright-core install chromium && \
RB_PASSWORD=some-long-password RB_LISTEN=8080 npm start
npm test
```

## Limits

One viewer at a time (a new window replaces the old one). No touch input, no copy-out of the remote clipboard, no audio. On macOS, Cmd is sent as Ctrl. Headless Chromium, so some sites that detect headless may object.
