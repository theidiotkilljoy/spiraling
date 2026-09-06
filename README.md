# I Want to Play a Game — synchronized d10 roller

A static multiplayer dice roller for the custom d10/Panic system. It is designed to be hosted on GitHub Pages and uses Firebase Realtime Database + anonymous authentication for synchronized rolls and shared history.

## What it does

- Every shared URL hash is its own game room.
- Everyone opening the same full URL sees the same rolls and history.
- Rolls are generated with `crypto.getRandomValues()`.
- Firebase's server-time offset is used to synchronize the reveal animation across clients.
- Advantage rolls twice automatically and uses the more favorable complete outcome.
- The player UI contains only the requested game title, inputs, roll result, Panic message, and shared history.
- The DM can change the room difficulty live without editing GitHub.

## Dice rules implemented

### Normal skill die

- `1` → 0 successes; if the check fails, gain 1 Panic.
- `2–5` → 0 successes.
- `6–9` → 1 success.
- `10` → 2 successes.

### Panic die

Panic dice replace normal dice. A roll never contains more total dice than the selected **Number of Dice**. If Panic exceeds the selected number of dice, only that many Panic dice are rolled.

- `1` → 0 successes; if the check fails, the result is **CRITICAL FAIL**.
- `2–9` → 0 successes.
- `10` → 1 success and removes 1 Panic.

### Critical Pass

Two or more `10`s in the selected roll produce **CRITICAL PASS**. Panic-die 10s count toward the two-10 requirement. A Critical Pass also removes 1 Panic.

### Panic gain/removal

- A failed roll containing one or more normal-die `1`s displays **YOU'RE PANICKING** and means the player gains 1 Panic.
- A roll can gain only 1 Panic regardless of how many normal 1s appear.
- A Panic 10 or Critical Pass removes 1 Panic.
- Gain/removal is calculated only from the selected Advantage roll.

### Difficulty

The player UI has no Difficulty field. Each room defaults to **Difficulty 2** until its DM changes it.

The DM opens the same room using `?dm=1` before the `#room-id`:

```text
https://username.github.io/repository/?dm=1#0a1b2c3d4e5f
```

Players use the ordinary room URL:

```text
https://username.github.io/repository/#0a1b2c3d4e5f
```

The first authenticated browser to open a new room in DM mode becomes that room's DM owner. That browser can set **Difficulty 1–5** at any time. The value is stored in Firebase and all later rolls in that room use it immediately.

`DEFAULT_DIFFICULTY` in `firebase-config.js` controls only the starting value before the DM sets one.

## Required custom dice images

Put these four PNG files in `/assets/`:

```text
assets/
  1.png
  success.png
  10.png
  crit1.png
```

They are used as follows:

- Normal die: one `1.png` face, four `success.png` faces, one `10.png` face, four blank faces.
- Panic die: one `crit1.png` face, one `10.png` face, eight blank faces.

If an image is absent while testing, the app falls back to simple symbols rather than breaking.

## Firebase setup

1. Create a project at Firebase Console.
2. Add a **Web App** to the project.
3. Open **Authentication → Sign-in method** and enable **Anonymous** authentication.
4. Create a **Realtime Database**.
5. Copy the Web App config into `firebase-config.js`.
6. In Realtime Database → Rules, replace the rules with the contents of `database.rules.json` and publish them.

Your Firebase web configuration is intended to be present in browser code. Security comes from Authentication and Database Rules, not from hiding the Firebase config values.

## GitHub Pages deployment

1. Create a new GitHub repository.
2. Upload the contents of this folder to the repository root.
3. In the repository, open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select your default branch (normally `main`) and `/ (root)`.
6. Save.
7. Open the GitHub Pages URL once. The app automatically adds a random room ID after `#`.
8. Before sending the room to players, open the room once in DM mode by adding `?dm=1` before the hash. This claims DM control for that browser.
9. Send players the **ordinary URL including the `#room-id` but without `?dm=1`**. Anyone with that exact player URL joins the same room.

Example shape:

```text
https://username.github.io/repository/#0a1b2c3d4e5f
```

Opening the base URL without the hash creates a new room automatically.

## Local testing

Because the JavaScript uses ES modules, test it through a local web server rather than opening `index.html` directly.

Python example:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

Firebase still needs to be configured for synchronized multiplayer testing.

## File structure

```text
.
├── index.html
├── styles.css
├── app.js
├── firebase-config.js
├── database.rules.json
├── README.md
└── assets/
    ├── 1.png
    ├── success.png
    ├── 10.png
    └── crit1.png
```

## Advantage behavior

Advantage produces two complete pools. Both are displayed. The app automatically selects the more favorable one using this order:

1. Critical Pass
2. Pass
3. Fail
4. Critical Fail

Within the same result class, a roll that removes Panic is preferred, then a roll that avoids gaining Panic, then the roll with more successes. The selected pool is outlined in the live view and history.

## Notes

- Maximum selected Skill dice: 5.
- Maximum stored Panic: 3; Panic dice used on a check cannot exceed the total selected Skill dice.
- Shared history keeps the latest 80 rolls per room. Change `HISTORY_LIMIT` in `firebase-config.js` if desired.
- DM ownership is tied to the anonymous Firebase identity in the browser that first claims the room. Clearing that browser's site data can therefore lose access to the DM control for that room. For a one-shot, keep the DM tab/browser profile intact until the session is finished.
- This is intentionally a static client app. There is no custom server to maintain.
