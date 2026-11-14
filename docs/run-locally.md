# Run Studio Assistant on your own computer

This puts the whole app on your computer: the website you use in the browser, the background worker that analyses
clips and renders edits, and its database. Your clips, customers and settings stay on your computer, and nothing
costs money. It takes about 20–30 minutes the first time, most of it waiting for installs.

You need one of these, with about 10 GB of free disk space:

- **A Mac with Apple silicon (M1 or newer) on macOS 15 Sequoia or newer.** On an Intel Mac, or on macOS 14 or older,
  Homebrew no longer has ready-made packages, so every tool would be compiled from source. That takes hours and
  Homebrew does not support it; ask me for other steps first. (Apple menu → About This Mac shows the chip and
  macOS version.)
- **A Windows 11 PC**, or Windows 10 version 2004 or newer (Settings → System → About).

All commands are typed into a terminal window. Copy each grey block, paste it, press Return, and wait for it to
finish before the next one.

---

## 1. Install the tools (once)

### On a Mac

1. Open **Terminal** (press Cmd+Space, type `Terminal`, press Return).
2. Install Homebrew, the standard Mac package installer, if you do not have it. Follow the one-line command on
   <https://brew.sh>, then run the "Next steps" lines it prints at the end (they add `brew` to your terminal).
   It also installs Apple's command-line tools, which include git.
3. Install the tools the app needs:

   ```bash
   brew install node@22 postgresql@16 ffmpeg-full
   ```

   Use `ffmpeg-full`, not plain `ffmpeg`: Homebrew's plain `ffmpeg` no longer includes the on-video text and
   iPhone HDR features the app needs. If it prints `Warning: node@22 has been deprecated`, that is expected; it
   still installs and works.

4. Make Node 22 and the full FFmpeg the ones your terminal uses:

   ```bash
   echo 'export PATH="$(brew --prefix node@22)/bin:$(brew --prefix ffmpeg-full)/bin:$PATH"' >> ~/.zprofile
   source ~/.zprofile
   ```

5. Turn on pnpm, the package manager this project uses:

   ```bash
   corepack enable pnpm
   ```

   If that says `corepack: command not found`, use `npm install -g pnpm@10` instead.

### On Windows

The app's helper scripts are written for Linux and macOS, so on Windows it runs inside **WSL** (Windows Subsystem
for Linux), which Microsoft provides for free. Your browser on Windows can still open it at `http://localhost:3000`.

1. Open **PowerShell as administrator** (Start menu → type `PowerShell` → right-click → Run as administrator) and
   run:

   ```powershell
   wsl --install -d Ubuntu-24.04
   ```

   Restart the PC if asked. When Ubuntu opens for the first time, choose a user name (short, lower case, no
   spaces) and a password. This is a separate Linux login, not your Windows one. **Nothing appears on screen while
   you type the password**; that is normal. Remember it: `sudo` asks for it later, again without showing it.
2. From now on, type every command into the **Ubuntu** window (Start menu → type `Ubuntu` → **Ubuntu 24.04 LTS**),
   not PowerShell.
3. Install the tools:

   ```bash
   sudo apt-get update
   sudo apt-get install -y git curl unzip ffmpeg postgresql-16 build-essential
   ```

   Installing PostgreSQL also starts Ubuntu's own database in the background. The app does not use it (it runs its
   own private one in section 3), so you can ignore it.
4. Install Node 22 with fnm (a small Node version manager), then pnpm:

   ```bash
   curl -fsSL https://fnm.vercel.app/install | bash
   source ~/.bashrc
   fnm install 22
   fnm default 22
   corepack enable pnpm
   ```

5. Keep the project inside Ubuntu's own folders (the next step does this). Do not put it under `/mnt/c/...`: it
   works there, but much more slowly.

---

## 2. Get the code (once)

```bash
cd ~
git clone https://github.com/Jaidenispog/editor.git studio-assistant
cd studio-assistant
git checkout claude/blissful-lamport-f1lndn
```

The latest work is on the `claude/blissful-lamport-f1lndn` branch (currently the repository's default, so the
checkout line just confirms it). The repository is public, so no GitHub sign-in is needed to download it. Your
own settings (`.env`), database and videos are never part of the repository.

---

## 3. Set it up (once)

Run these from inside the `studio-assistant` folder.

1. Let pnpm fetch the exact version this project uses:

   ```bash
   pnpm --version
   ```

   The first time, it may ask `Do you want to continue? [Y/n]`: type `Y` and press Return. It should print
   `10.28.0`.

2. Check that every tool is found. It prints `ok` lines, or tells you exactly what is missing and how to install
   it:

   ```bash
   bash scripts/check-tools.sh
   ```

3. Download the project's libraries (about a minute). Ignore any "Update available" box it shows; the project
   stays on pnpm 10:

   ```bash
   pnpm install
   ```

4. Start a private database for the app. It stores its data in the project's `.pg` folder and only your own
   computer can reach it:

   ```bash
   bash scripts/local-postgres.sh start
   ```

   It ends with `Ready. Put these in your .env …` and two addresses. You do not need to copy them: the settings
   file in the next step already contains them.

5. Create your settings file and fill in the one required secret:

   ```bash
   cp .env.example .env
   SECRET="$(openssl rand -base64 48 | tr -d '\n')"
   sed -i.bak "s|^APP_SECRET=.*|APP_SECRET=$SECRET|" .env && rm .env.bak
   grep '^APP_SECRET=' .env | cut -c1-20
   ```

   The last line should print `APP_SECRET=` followed by the start of a long random value. Keep `.env` private:
   it holds the key that protects sign-ins and stored tokens.

6. Create the database tables:

   ```bash
   bash scripts/dev.sh migrate
   ```

   It should end with `Migrations applied`.

---

## 4. Start the app (every time)

On Windows, open the **Ubuntu 24.04 LTS** window first and type these there.

```bash
cd ~/studio-assistant
bash scripts/local-postgres.sh start
bash scripts/dev.sh
```

Leave that window open: it runs the website and the worker together, and their messages scroll past prefixed
`[web]` and `[worker]`. After `Ready` appears, each page takes a few seconds to open the first time while the
website prepares it; that is normal.

**Straight away**, open **<http://localhost:3000/setup>** in your browser and create the owner account (your
email and a password of at least 10 characters). Do this first: until an owner exists, whoever opens this page
can create one. The app only answers on this computer, so phones and other devices on the Wi-Fi cannot open it,
unless you switch that on with `WEB_HOST` in `.env` (see the comment there); then they can reach this page too.
After that, sign in at <http://localhost:3000>.

To stop: press **Ctrl+C** in that window, then `bash scripts/local-postgres.sh stop`.

---

## 5. Try it

- Make a project in **Video Studio**, drag in two or three haircut clips from your phone (MOV or MP4), tag what
  each shows (before, cutting, result), and press **Generate 5 edits**. Analysis and rendering run in the
  `[worker]` lines and take a few minutes on a laptop.
- No real clips to hand? The project can make synthetic test clips (colour bars, not haircuts):

  ```bash
  bash scripts/make-sample-footage.sh data/samples
  ```

  It prints some `x265 [info]` lines while it works; that is normal. To see the clips so you can drag them into the
  browser, open the folder: on a Mac run `open data/samples`; on Windows run `explorer.exe data/samples` in the
  Ubuntu window (or type `\\wsl$\Ubuntu-24.04\home\` in File Explorer's address bar, then open your Linux user
  name → `studio-assistant` → `data` → `samples`).
- Without an AI key, edits come from the built-in rules editor and say so on each card. Speech captions and the
  AI planner switch on later by adding keys to `.env` (see the comments in it). Instagram, TikTok, Square, email
  and Google show "Needs setup" until their accounts are connected.

---

## 6. Getting the latest version later

Stop the app first (Ctrl+C in its window), then:

```bash
cd ~/studio-assistant
git checkout -- apps/web/next-env.d.ts 2>/dev/null || true
git pull
corepack enable pnpm
pnpm install
bash scripts/local-postgres.sh start
bash scripts/dev.sh migrate
bash scripts/dev.sh
```

The `git checkout` line undoes changes to a small file the website rewrites every time it runs (it holds none of
your data), so `git pull` does not refuse to update; once your copy no longer tracks that file it does nothing.
`corepack enable pnpm` is needed again after Homebrew updates Node.

---

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `check-tools.sh` reports something MISSING | Run the install command it prints, then run it again. |
| Mac: MISSING filter `ass` or `zscale` | Plain `ffmpeg` is installed. Run `brew install ffmpeg-full` and step 1.4 of the Mac section, then open a new Terminal window. |
| `PostgreSQL 16 or newer was not found` | Mac: `brew install postgresql@16`. Ubuntu: `sudo apt-get install -y postgresql-16`. |
| `Port 5433 on 127.0.0.1 is already used by another program` | Another database is using it. Run `echo 'export LOCAL_PG_PORT=5434' >> ~/.bashrc && source ~/.bashrc` (Mac: `~/.zprofile` instead of `~/.bashrc`), run `bash scripts/local-postgres.sh start` again, and change `5433` to `5434` in `DATABASE_URL` in `.env`. |
| `Port 3000 is in use … using available port 3001 instead` | Another program has port 3000. In `.env`, change `APP_URL=http://localhost:3000` to `APP_URL=http://localhost:3001` and add a line `PORT=3001`, restart with `bash scripts/dev.sh`, and use 3001 wherever this guide says 3000. |
| `ECONNREFUSED 127.0.0.1:5433` in the `[worker]` lines or when migrating | The database is not running (for example after a restart). Run `bash scripts/local-postgres.sh start`, then start the app again. |
| `Invalid environment configuration … APP_SECRET` | Step 3.5 did not save the secret. Open `.env` in a text editor and paste a long random value after `APP_SECRET=`. |
| The browser says the site can't be reached | Check the `dev.sh` window is still running and shows `Ready`. On Windows, open `http://localhost:3000` in the Windows browser while the Ubuntu window runs it. A phone or another computer cannot open it unless `WEB_HOST` is set in `.env` (see the comment there). |
| Clips stay on "Waiting to be analysed" | The background worker that does the work is not running. The project page then says **"The background worker isn't running"** above your clips. Look at the `dev.sh` window: `Waiting for the database at 127.0.0.1:5433` in the `[worker]` lines means the database is off, so run `bash scripts/local-postgres.sh start` in another window (the worker carries on by itself once it can connect). If the window says the worker stopped and was not restarted, read the `[worker]` lines just above that message, fix what they name, and start the app again with `bash scripts/dev.sh`. Nothing is lost: waiting clips start by themselves once the worker runs. |
| Clips stay on "Analysing" | Look at the `[worker]` lines for an error; most often FFmpeg is missing a feature that `check-tools.sh` names. |
| Windows: `wsl --install` stops with error 0x80370102 or 0x80070003 | Virtualisation is switched off in the PC's BIOS/UEFI settings (usually under the CPU options). Turn it on, restart, and run the command again. |
| Windows: the install sits at 0.0% | Press Ctrl+C and run `wsl --install --web-download -d Ubuntu-24.04` instead. |

## What has and has not been tested

- **Ubuntu 24.04 (the Linux that WSL installs):** sections 2–5 were run word for word from a fresh download of
  the project on 14 November 2026: tool check, install, database, settings, migration, start, the setup page, the
  health check and the sample clips all worked. The Windows parts themselves (installing WSL, opening the app from
  the Windows browser) were checked against Microsoft's documentation, not run on a Windows PC.
- **Mac:** checked line by line against Homebrew's own package definitions and the Node, pnpm and macOS tool
  sources, which is how the `ffmpeg-full` requirement was found. It has not been run on a Mac yet.
- **Later changes (also 14 November 2026, on Linux):** the website now answers only on this computer unless
  `WEB_HOST` is set. Without `WEB_HOST`, the computer's own network address refused the connection and the app
  worked as before at `localhost`. With `WEB_HOST=0.0.0.0`, the app was opened in a browser (headless Chrome) at
  the computer's numeric network address: the page loaded and became interactive, the setup form created the owner
  account and the sign-in form signed in. It has not been tried from a real phone, through WSL, or by a name such
  as `my-laptop.local` (`WEB_DEV_ORIGINS`). The section 6 lines were run on a copy that still tracked the rewritten
  file and again after the change.

If a step fails for you, copy the message and send it to me.
