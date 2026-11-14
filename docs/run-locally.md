# Run Studio Assistant on your own computer

This puts the whole app on your computer: the website you use in the browser, the background worker that analyses
clips and renders edits, and its database. Nothing is sent anywhere and nothing costs money. It takes about
20–30 minutes the first time, most of it waiting for installs.

You need: a Mac, or a Windows 10/11 PC, with about 10 GB free disk space. All commands are typed into a terminal
window. Copy each grey block, paste it, press Return, and wait for it to finish before the next one.

---

## 1. Install the tools (once)

### On a Mac

1. Open **Terminal** (press Cmd+Space, type `Terminal`, press Return).
2. Install Homebrew, the standard Mac package installer, if you do not have it. Follow the one-line command on
   <https://brew.sh>, then the "Next steps" lines it prints at the end (they add `brew` to your terminal).
3. Install the tools the app needs:

   ```bash
   brew install node@22 postgresql@16 ffmpeg git
   ```

4. Make Node 22 the one your terminal uses:

   ```bash
   echo 'export PATH="$(brew --prefix node@22)/bin:$PATH"' >> ~/.zprofile
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

   Restart the PC if asked. When Ubuntu opens for the first time, choose a user name and password (this is a
   separate Linux login; remember the password, `sudo` asks for it).
2. From now on, type every command into the **Ubuntu** window (Start menu → Ubuntu), not PowerShell.
3. Install the tools:

   ```bash
   sudo apt-get update
   sudo apt-get install -y git curl ffmpeg postgresql-16 build-essential
   ```

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

1. Check that every tool is found. It prints `ok` lines, or tells you exactly what is missing and how to install it:

   ```bash
   bash scripts/check-tools.sh
   ```

2. Download the project's libraries:

   ```bash
   pnpm install
   ```

3. Start a private database for the app. It stores its data in the project's `.pg` folder and only your own
   computer can reach it:

   ```bash
   bash scripts/local-postgres.sh start
   ```

4. Create your settings file and fill in the one required secret:

   ```bash
   cp .env.example .env
   SECRET="$(openssl rand -base64 48 | tr -d '\n')"
   sed -i.bak "s|^APP_SECRET=.*|APP_SECRET=$SECRET|" .env && rm .env.bak
   grep '^APP_SECRET=' .env | cut -c1-20
   ```

   The last line should print `APP_SECRET=` followed by the start of a long random value. Keep `.env` private:
   it holds the key that protects sign-ins and stored tokens.

5. Create the database tables:

   ```bash
   bash scripts/dev.sh migrate
   ```

   It should end with `Migrations applied`.

---

## 4. Start the app (every time)

```bash
cd ~/studio-assistant
bash scripts/local-postgres.sh start
bash scripts/dev.sh
```

Leave that window open: it runs the website and the worker together, and their messages scroll past prefixed
`[web]` and `[worker]`. The first start takes a minute while the website compiles.

Then open **<http://localhost:3000/setup>** in your browser and create the owner account (your email and a
password of at least 12 characters). After that, sign in at <http://localhost:3000>.

To stop: press **Ctrl+C** in that window, then `bash scripts/local-postgres.sh stop`.

---

## 5. Try it

- Make a project in **Video Studio**, drag in two or three haircut clips from your phone (MOV or MP4), tag what
  each shows (before, cutting, result), and press **Generate 5 edits**. Analysis and rendering run in the
  `[worker]` window and take a few minutes on a laptop.
- No real clips to hand? The project can make synthetic test clips (colour bars, not haircuts):

  ```bash
  bash scripts/make-sample-footage.sh data/samples
  ```

  They are saved in `data/samples` for you to drag in.
- Without an AI key, edits come from the built-in rules editor and say so on each card. Speech captions and the
  AI planner switch on later by adding keys to `.env` (see the comments in it). Instagram, TikTok, Square, email
  and Google show "Needs setup" until their accounts are connected.

---

## 6. Getting the latest version later

```bash
cd ~/studio-assistant
git pull
pnpm install
bash scripts/dev.sh migrate
bash scripts/dev.sh
```

---

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `check-tools.sh` reports something MISSING | Run the install command it prints, then run it again. |
| `PostgreSQL 16 or newer was not found` | Mac: `brew install postgresql@16`. Ubuntu: `sudo apt-get install -y postgresql-16`. |
| `Port 5433 is already in use` | Another database is using it. Start with `LOCAL_PG_PORT=5434 bash scripts/local-postgres.sh start`, and change `5433` to `5434` in `DATABASE_URL` in `.env`. |
| `Invalid environment configuration … APP_SECRET` | Step 3.4 did not save the secret. Open `.env` in a text editor and paste a long random value after `APP_SECRET=`. |
| The browser says the site can't be reached | Check the `dev.sh` window is still running and shows `Ready`. On Windows, open `http://localhost:3000` in the Windows browser while the Ubuntu window runs it. |
| Clips stay on "Analysing" | Look at the `[worker]` lines for an error; most often FFmpeg is missing a feature that `check-tools.sh` names. |

## What has and has not been tested

The scripts these steps use are the ones the project's own tests run on Ubuntu 24.04 (the same Linux that WSL
installs). A word-for-word run of this guide from a fresh copy, and a check of the Mac and Windows steps against
the official Homebrew, Microsoft and Node documentation, are in progress; this note will say what passed. If a step
fails for you, copy the message and send it to me.
