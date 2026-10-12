# Oil N Wine

A responsive worship-song controller and projector display built with Node.js, Express, SQLite, and WebSockets.

## Requirements

- Node.js 22.5 or newer (the server uses the built-in `node:sqlite` module)
- npm

## Run locally

```powershell
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) for the controller. Open [http://localhost:3000/display](http://localhost:3000/display) in a separate window for the projector view.

The server creates a fresh SQLite database and its tables on first start. Database files are local runtime data and are ignored by Git. If no administrator exists, the server creates the initial `admin` account with password `admin123`; change that password after signing in.

## Development mode

```powershell
npm run dev
```

This restarts the server when source files change.
