# CODE KILLER

A multiplayer hide-and-seek battle royale in a foggy 3D village. Every player has a secret 4-digit code floating over their head. **You can read everyone else's code, but never your own.** Open the kill box, type a living player's code, and they're gone. Last one alive wins.

## Install & run

Requires Node.js 22+ (developed on Node 24).

```bash
npm install        # at the repo root: installs server + client (npm workspaces)
npm run dev        # game server on :3000 + Vite client on :5173 (the client connects to http://localhost:3000)
```

Open http://localhost:5173, enter a name and **Create Room**. To test alone, click **+ Bot** a few times, then **Start Game**. Friends on your network can join with the 6-character room code, or the `https://<site>/<ROOMCODE>` link that clicking the code copies.

```bash
npm test           # server tests (node:test)
npm run build      # production build of the client -> client/dist
npm start          # game server only (Socket.io + /health + /stats) on $PORT, default 3000
```

Port 3000 already taken locally? Run the server on another port and point the client at it (bash syntax):
`PORT=3001 npm run dev -w server` and `VITE_SERVER_URL=http://localhost:3001 npm run dev -w client`.

## How to play

- **Your code is hidden from you.** It shows as `? ? ? ?` over your head and in the top-left HUD.
- **Decoding:** from far away you see `? ? ? ?`. Get closer to reveal 1 digit, then 2 digits. Within about 6 m you see all 4. Each viewer decodes a given player's digits in its own fixed order. A fully decoded code turns **red**.
- **Kill box (`E`):** type 4 digits and press `Enter`. You move at 20% speed while it's open, and other players see **TYPING** over your head. A wrong guess triggers the host's penalty. Typing your own code counts as a wrong guess.
- **Line of sight:** walls and closed doors block codes. Windows and open doorways don't.
- **Hiding:** stand still in a bush, under a bed, behind a curtain, or in any dark room or basement, and your code disappears. **Wardrobes and lockers** (`F`) hide you completely.
- **Mirrors and puddles:** stand in front of one and look at it. Every 5 s there's a 25% chance you glimpse **one** digit of your own code and its position.
- **Bounty:** every 60 s after grace, one player is marked and glows gold for 30 s. Whoever kills them chooses a reward: **see their own full code for 5 s**, or an **instant shuffle**. Surviving as the bounty earns a random item.
- **Lights out:** happens twice per game. There's a 3 s siren first, then 10–15 s of darkness where codes are readable only within 3 m, unless you carry a **flashlight**.
- **The zone** shrinks in stages; outside it you take damage. There's a grace period at the start.

### Death & spectating

- When you die, a **3-second death screen** shows `ELIMINATED BY <name>` in the killer's colour and how long you survived. A zone death shows `CONSUMED BY THE ZONE`.
- After that you **spectate in first person**:
  - **Killed by a player:** you watch through your killer's eyes.
  - **Zone or other deaths:** you watch the nearest living player.
- `←`/`→` (or a click) switches between living players. The name of the player you're watching is shown at the top in their colour.
- If the player you're watching dies, you automatically switch to **their** killer.
- `↓` gives a free-flying ghost camera; `↑` goes back to spectating. Ghosts read every code and chat only with other ghosts.

### View & graphics

- **First-person view.** Each round opens in third person behind your character for about 2 seconds, then the camera glides into your eyes. Your body faces wherever you look, so others can tell where you're watching.
- **Weather:** light fog only. It is purely visual and never changes what you can read.
- **Graphics (home screen or lobby):** Low, Medium or High, saved per browser. A small FPS meter sits above the minimap.
  - **Low:** no shadows, no live reflections, 4 dynamic lights.
  - **Medium (default):** 1024 shadow map refreshed every 3rd frame, live mirror and puddle reflections up close.
  - **High:** 2048 soft shadows every frame, sharper reflections.

### Controls

| Key | Action |
|---|---|
| WASD / Mouse | Move / look (click the game to lock the mouse). Doors open by themselves when you walk up to them, and stairs are walked up like ramps. |
| Shift | Crouch-walk (silent, 50% speed) |
| E | Kill box: digits, `Backspace`, `Enter` to strike, `Esc` to close |
| F | Use whatever is nearest: light switch, wardrobe/locker, vent, security monitors |
| 1 / 2 | Use the item in slot 1 / 2 |
| Q | Drop an item (`Q` then `1`/`2` when carrying two) |
| T or Enter | Chat |
| In a vent | `A`/`D` pick a duct, hold `W` to crawl (`S` to go back), `F` to climb out at an opening |
| Bounty reward | `Z` = learn your code, `X` = shuffle (or click a card) |
| Dead | `←`/`→` or click: switch spectated player · `↓` free camera (WASD, Space/C) · `↑` back to spectating |

### Items

You have 2 slots. Items glow and rotate on the ground, respawn over time, and drop when you die. There are only three:

| Item | Rarity | Effect (validated and timed on the server) |
|---|---|---|
| 🗝️ Master Key | common | Opens a **sealed door** (red light) when you stand next to it. The door then stays open for the rest of the round. It is not used up if there's no sealed door nearby. |
| 🔦 Flashlight | common | Toggle. Reads codes in dark rooms, basements and lights-out inside its cone (14 m). Everyone sees the beam. |
| 🔀 Code Shuffle | rare | Gives you a brand-new code (you're not told what it is). Everyone who memorised your old one is wrong. |

**Hoods** (mask 2 of your digits for 30 s) also spawn on the ground.

## Host settings

Max players (2–16), wrong-guess penalty (lockout / reveal location / die after N), grace period, zone speed, lights-out on or off, and adding or removing bots. The lobby shows how large the zone will start for the current headcount.

## The map: one fixed, hand-designed village

`shared/village.js` defines the map. It is the same every game, so players can learn it.

**Three house types**, each designed once in local coordinates and then placed with variations (rotation, mirroring, wall/roof colours, furniture layout):

| House | Floors | Rooms | Features |
|---|---|---|---|
| Small house (9×7) | 1 | living room, bedroom, kitchen | bed + wardrobe + curtain hiding spots, mirror, front and back door |
| Family house (12×9) | 2 | 5: kitchen, living, 2 bedrooms, bathroom | walkable staircase with banisters, bathroom mirror, wardrobes, beds |
| Big house (14×11) | 2 + dark basement | 6+ | two staircases, a vent in the boiler room, a sealed storage room in the basement, 3 exits |

Every house is furnished and has windows, light switches on the walls, at least 2 hiding spots and at least 2 normal exits, so nobody gets trapped.

**The village** has 10 buildings along a cross of streets:
- 2 small houses + a mirrored variant, 2 family houses (one mirrored), 2 big houses (one mirrored), a **shop** with a sealed storeroom, the **security building** (monitors for 4 cameras), and a shed.
- Outside: a **central square** with a fountain, a **park** with bushes and trees, an **alley** with a sealed shortcut door, gardens and street lamps.
- **5 sealed doors** in total. Behind them are shortcuts, good hiding spots or item spawns.

**Fixed spawns and items:**
- **Spawns:** 16 player spawns and 33 item spots, all fixed and spread evenly.
- **Small games** (2–4 players) keep the same map, but the zone starts smaller (26 m radius instead of 52 m) and players spawn inside it, so they still meet.
- **Map data:** plain JSON, sent once in `game:start`, so client and server always share the same geometry.

**Stairs are real ramps in a real stairwell.** You walk up them; there's no teleport.
- **Stairs:** 1.3 m wide (a player is 0.8 m). The floor height follows the ramp, and halfway up you switch to the next floor.
- **The opening:** the upper floor is built from slab pieces around a rectangular opening exactly above the stairs, in the map data itself (`carveStairwells()` in `shared/mapkit.js`).
  - Every copy of every house gets it.
  - The ground-floor ceiling has the matching opening, and no floor surface or floor collider covers it.
  - The basement stairs get the same opening in the ground floor.
- **Railing:** a wooden lip edges the opening, and banisters run along its 3 open sides upstairs. The stair entry stays open, and the same banisters stop you stepping onto the ramp from the side.
- **Ceiling lamps:** a lamp that would hang in the opening is moved onto the ceiling beside it.
- **Tests:** automated tests check that nothing covers any opening. They walk every staircase up, and down through the opening, with real movement packets and check eye height against the ceiling. A bot also goes ground floor → upstairs bedroom → back in every 2-floor house.

## Doors

- **Normal doors open automatically** when anyone (players or bots) walks up to them, and close about 0.7 s after everybody has left. They swing smoothly, and the open/close sound is positional, so people nearby hear it. Your own client predicts the door so you never bump into it.
- **Sealed doors (red light)** are permanently locked. Only a **Master Key** opens one, and it then stays open for the rest of the round.
- There's no door locking any more.

## Project layout

```
shared/        (used by both sides)
  constants.js    tuning (vision, zone, doors, FOV), zoneStartRadius()
  mapkit.js       map-building toolkit (walls with openings, rooms, stairs + rails, furniture, hiding spots)
  village.js      the 3 house designs + the fixed village layout
  mapgen.js       entry point: generateMap() -> the village
  world.js        per-level collision with door state, stairs (ramp height / floor switch), darkness, hide spots
  geometry.js     2D collision + line of sight with a uniform-grid broadphase
  items.js        the 3 items + rarity roll
server/src/
  room.js         lobby, movement validation, kills, death/win, snapshots
  systems/        environment.js (auto doors, sealed doors, lights, stairs, lockers, vents, security, reflections, lights-out)
                  items.js (inventory + item effects), bounty.js
  visibility.js   the ONLY place code digits are decided for a viewer (players and bots)
  bots.js / nav.js  bot AI + multi-level A* (0.5 m grid, stairs as links, region labels)
client/src/
  game/world.js   renderer (merged geometry per material and region, light pool, reflectors, pooled pickups)
  game/game.js    loop, prediction/interpolation, cameras, death screen + spectating, shader warm-up, spike logger
  ui/             HUD (inventory, death screen, bounty, minimap), kill box
```

## Deployment (server on Render free plan, client on Netlify)

The game server and the web client are deployed separately. The server never serves the client.

### 1. Game server → Render

**Option A, Blueprint (recommended):** Render → **New + → Blueprint** → pick the repo. `render.yaml` creates the `code-killer-server` web service (free plan, Frankfurt, branch `main`) with everything below; you only type in `CLIENT_ORIGIN` when asked. `STATS_KEY` is generated for you.

**Option B, by hand:** **New → Web Service** → connect the repo, then:

| Setting | Value |
|---|---|
| Root directory | *(leave empty: repo root)* |
| Runtime | Node |
| Build command | `npm ci --omit=dev --workspace=server` |
| Start command | `node server/src/index.js` |
| Health check path | `/health` |
| Instance type | Free |

**Environment variables** (see `server/.env.example`):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `CLIENT_ORIGIN` | Your Netlify URL, e.g. `https://code-killer.netlify.app`. Comma-separate several (custom domain, deploy previews). No trailing slash. |
| `STATS_KEY` | A long random string. It protects `/stats` and `/spikes`; leave it unset to disable both. |
| `PORT` | Set automatically by Render (falls back to 3000 locally). |

Never set `CK_DEBUG` in production.

**Check:**
- `https://<service>.onrender.com/health` returns `ok`.
- `https://<service>.onrender.com/stats?key=<STATS_KEY>` shows players online, rooms, average and max tick time, memory and uptime.

### 2. Web client → Netlify

**Add new site → Import from Git** → pick the repo, then:

| Setting | Value |
|---|---|
| Build settings | Leave **Base directory, Build command and Publish directory empty** in the UI. The root `netlify.toml` sets base `client`, command `npm run build`, publish `dist` (that is, `client/dist`), Node 22 and the `/* → /index.html 200` rule. Building inside the full checkout keeps `../shared` reachable. |
| Environment variable | `VITE_SERVER_URL=https://<service>.onrender.com` (no trailing slash; see `client/.env.example`). It's baked in at build time, so redeploy after changing it. |

**Share links:** `https://<site>/<ROOMCODE>` opens the game with the join box pre-filled.

### 3. Connect them

Put the Netlify URL into the server's `CLIENT_ORIGIN` on Render. Other origins are refused; localhost is allowed only when `NODE_ENV` isn't `production`.

### Free-plan notes

- **Cold start:** Render's free plan sleeps after ~15 min without traffic, and the first visit then takes up to a minute to wake it. The client shows *"Server is waking up, this can take up to a minute"* after 5 s and keeps retrying by itself.
- **Single instance:** rooms live in memory, so run one instance. A restart or redeploy ends all running games.
- **API keys:** none are needed. Bots run entirely on the server with no external AI service. Any future key belongs in an environment variable, never in the code or the client.

## Design decisions

**Server-authoritative, anti-cheat first.**
- **Codes:** `visibleCode()` decides, per viewer, which digits are sent. Its inputs are distance, line of sight through walls and doors (by door state), floor level, darkness and lights, the flashlight cone, hoods, hiding and vents.
- **Your own code** is sent to you only through the bounty "reveal" reward, and a mirror glimpse sends exactly one digit plus its position. Tests check both.
- **Security cameras** count as extra viewers (same rules, merged results) only while you're sitting in the chair.

**Movement:**
- Clients send positions (and their floor). The server checks each against a speed budget, opens nearby doors, collides it against that floor's geometry, follows the stairs, and corrects drift or a wrong floor.

**Bots see like players:**
- Bots use the same `visibleCode()` rules as players, plus a **forward view cone of 90°** (the player camera is 75° vertical ≈ 106° horizontal on 16:9).
  - Everyone within 1.2 m is noticed regardless of direction.
  - Distance tiers, line of sight, darkness, flashlight cones, hoods and vents all apply.
- Bots only know codes they have read this way.
- They turn their heads and bodies: they look along their path, scan around while standing still, and face whoever they're reading or attacking.
- They walk through auto doors and up and down stairs. They use Master Keys at sealed doors, Flashlights in the dark, and Code Shuffle when someone nearby is typing. They prioritise the bounty.

**Visibility in the dark:** basements are always dark. Rooms are dark when their switch is off, and lights-out applies everywhere. Dark spots are readable within 4 m (3 m during lights-out); a flashlight cone restores normal reading.

**Vents:** a ring of ducts. Crawling is slow (1.8 m/s). While inside you can't be read and can't read anyone, and nearby players hear clanking.

**Security room:** one chair, 4 camera feeds in split-screen, and you can't move while watching. You leave with `F`, or you're forced out by zone damage, a kill attempt within 8 m, or someone typing your correct code.

**Visuals:** procedural textures only (no image files), merged static geometry per material and region, and wall faces routed so exteriors get siding and interiors get plaster tinted by room type.

## Performance & the spike logger

**Spike logger (always on):**
- **Client:** any frame over 50 ms is logged with:
  - frame and JS work time, recent network events (door, pickup, lights-out, death…);
  - shader-program count and newly compiled programs, geometries and textures;
  - draw calls, JS heap, players nearby, the current phase, and long tasks.
- **Where the logs go:**
  - `window.__ckSpikes` in the browser console;
  - reported to the server (`perf:spike`, rate-limited).
- **Warnings:** the console also warns if a shader is compiled, or a texture or geometry is created, during play.
- **Server:** any tick over 50 ms (and any GC pause over 20 ms) is logged with the room, phase, players, bots, events that tick, remaining path budget, heap and recent GC.
- **Viewing:** everything is printed and available at `GET /spikes`.

**Fixes made from it:**
- **Shader warm-up at load:** every material and effect is compiled before the first frame with `renderer.compileAsync`. That covers characters (normal, ghost, hood, bounty, flashlight), every pickup, the death effect, lights-out, ducts, mirrors/puddles (including their reflection passes) and the security cameras.
  - The page stays responsive while shaders compile in parallel.
  - All textures are uploaded, and one culling-free render uploads every vertex buffer.
  - **Result:** 0 shaders compiled during play.
- **No creation during play:**
  - Pickups share geometry and materials per item type.
  - Death effects reuse shared geometry.
  - Name and code labels upload when a player first appears.
  - Per-frame `Vector3` and `Color` allocations were removed.
- **Server:**
  - The bot nav grid is built once per process (the map is fixed), at round start rather than inside the first tick.
  - At most 3 path searches run per tick, and a bot without a path waits one tick.
  - Unreachable goals (behind sealed doors) are rejected instantly via connected-region labels instead of flooding the grid.
  - **Boot warm-up:** at start-up the server plays a ~0.2 s offline bot game, so the first real round runs on optimised code.
  - **Result:** the first tick went from 45 ms to ~5 ms; typical ticks are ~0.03 ms.
- **Security monitors:**
  - Each camera renders into a 640×360 offscreen target, two cameras per frame in turn, then one cheap pass shows the 4 feeds.
  - Mirror/puddle reflections and shadow refreshes pause while watching.
  - This replaces 4 full-screen scene renders per frame.
- **Becoming a ghost:** characters of players who drop out of your snapshot are parked and reused, not destroyed, so dying doesn't rebuild every character's meshes and labels. Your own ghost look is part of the shader warm-up.
- **Vent overlay:** plain transparency instead of a full-screen blend mode and a giant box-shadow composited over the 3D canvas.

## Debugging

`CK_DEBUG=1 npm run dev` (server side) enables test-only socket commands (`dev:tp`, `dev:give`, `dev:event`) used by automated browser play-tests. They are **off by default**, and a test checks that they don't exist otherwise. In dev builds, `window.__ck` exposes client state and `window.__ckGame` the running game (`debugCam` is used for screenshots).

## Known limitations

- Line of sight is 2D per floor (heights only decide which objects block it).
- Bots don't use vents or the security room.
- No touch controls in game.
