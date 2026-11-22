import "dotenv/config";

import express from "express";

const app = express();

const API_URL = process.env.APEX_API_URL?.replace(/\/+$/, "");
const ADMIN_KEY = process.env.APEX_ADMIN_KEY;

if (!API_URL || !API_URL.startsWith("https://")) {
  throw new Error("APEX_API_URL must be an HTTPS URL.");
}

if (!ADMIN_KEY) {
  throw new Error("Missing APEX_ADMIN_KEY.");
}

app.disable("x-powered-by");
app.use(express.urlencoded({
  extended: false,
  limit: "8kb"
}));

app.get("/admin", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Apex Administration</title>

  <style>
    * { box-sizing: border-box; }

    body {
      background: #101114;
      color: #ffffff;
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 25px;
    }

    main {
      max-width: 480px;
      margin: 35px auto;
      background: #191b21;
      padding: 25px;
      border-radius: 14px;
      border: 1px solid #30333d;
    }

    h1 { margin-top: 0; }

    p { color: #aeb2bd; }

    label {
      display: block;
      margin-top: 18px;
      margin-bottom: 7px;
      font-size: 14px;
    }

    input {
      width: 100%;
      padding: 13px;
      background: #101114;
      border: 1px solid #393d48;
      color: white;
      border-radius: 7px;
    }

    button {
      width: 100%;
      padding: 14px;
      margin-top: 24px;
      background: #5865f2;
      color: white;
      border: none;
      border-radius: 8px;
      font-weight: bold;
      cursor: pointer;
    }

    button:hover { background: #4752c4; }

    .notice {
      font-size: 12px;
      color: #999eaa;
      margin-top: 20px;
    }
  </style>
</head>

<body>
  <main>
    <h1>APEX</h1>
    <p>Server Authorization Dashboard</p>

    <form method="POST" action="/authorize">

      <label>Discord Server ID</label>
      <input
        name="guildId"
        required
        inputmode="numeric"
        autocomplete="off"
        placeholder="Server ID"
      >

      <label>Server Owner ID</label>
      <input
        name="ownerId"
        required
        inputmode="numeric"
        autocomplete="off"
        placeholder="Owner ID"
      >

      <label>Customer Bot Token</label>
      <input
        name="botToken"
        type="password"
        required
        autocomplete="new-password"
        placeholder="Paste bot token"
      >

      <button type="submit">AUTHORIZE SERVER</button>
    </form>

    <div class="notice">
      Tokens are validated and encrypted before database storage.
      Never share this dashboard with unauthorized people.
    </div>
  </main>
</body>
</html>
  `);
});

app.post("/authorize", async (req, res) => {
  const { guildId, ownerId, botToken } = req.body;

  if (
    !/^\d{17,20}$/.test(guildId || "") ||
    !/^\d{17,20}$/.test(ownerId || "") ||
    typeof botToken !== "string" ||
    botToken.length < 30 ||
    botToken.length > 200
  ) {
    return res.status(400).send("Invalid form information.");
  }

  try {
    const response = await fetch(
      `${API_URL}/internal/licenses`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-apex-admin-key": ADMIN_KEY
        },
        body: JSON.stringify({
          guildId,
          ownerId,
          botToken
        }),
        signal: AbortSignal.timeout(20000)
      }
    );

    const result = await response.json();

    if (!response.ok) {
      return res.status(response.status).send(`
        <h2>Authorization failed</h2>
        <p>${String(result.error || "Unknown error")}</p>
        <a href="/admin">Go back</a>
      `);
    }

    return res.send(`
      <h2>Server Authorized</h2>
      <p>Apex successfully registered the server.</p>
      <p>Server ID: ${guildId}</p>
      <p>Application ID: ${result.applicationId}</p>
      <a href="/admin">Authorize another server</a>
    `);

  } catch {
    return res.status(502).send(
      "Could not connect to the Apex API."
    );
  }
});

app.listen(3001, "127.0.0.1", () => {
  console.log("");
  console.log("APEX ADMIN DASHBOARD");
  console.log("http://127.0.0.1:3001/admin");
  console.log("");
});
