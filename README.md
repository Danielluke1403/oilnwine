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

Open [http://localhost:3000](http://localhost:3000) for the controller. Sign in, select a group, then use **Projector Window** to open the display for that group.

The server creates a fresh SQLite database and its tables on first start. It does not create a placeholder group or assign accounts to groups automatically; a master admin or group admin must add each account explicitly. Master admins are not automatically made group members. A master admin can create groups and assign the first group admins, then view every group's expandable member roster. Group admins can manage members only in groups where they are admins. Accounts are added to each group separately, and display, add-song, and edit-song permissions are checked against the active group's membership. Admin rights and permissions do not carry between groups. Songs themselves are shared globally, so an authorized edit changes the same song for every group. Each group's live display state remains separate. Song revisions record who changed a song and when; rollback requires edit permission in the active group.

Database files are local runtime data and are ignored by Git. If no master administrator exists, the server creates the initial `admin` account with password `admin123`; change that password after signing in. Existing SHA-256 password hashes are upgraded to salted scrypt hashes after a successful login.

## Development mode

```powershell
npm run dev
```

This restarts the server when source files change.
