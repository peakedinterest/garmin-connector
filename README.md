# Garmin connector for Claude

A private connector that lets Claude read your own Garmin Connect data (activities, sleep, HRV, resting heart rate, Body Battery, stress, steps, food log and hydration) through Garmin's official Personal API. It runs on your own free Cloudflare account and is read-only.

## What you need

- Your Garmin Personal API key (the one you created in Garmin Connect).
- A free Cloudflare account: https://dash.cloudflare.com/sign-up. Turn on two-factor sign-in under My Profile > Authentication, because this account will hold your Garmin key.
- For setup from a computer only: Node.js (LTS version from https://nodejs.org).

## Setup from a phone or any browser

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/peakedinterest/garmin-connector)

1. Tap the button above. Sign in to Cloudflare and connect GitHub when asked.
2. Keep the suggested names. When the form asks for `GARMIN_API_KEY` and `OWNER_PASSPHRASE`, enter your Garmin key and a passphrase of at least 16 characters (such as four unrelated words). You'll type the passphrase once when you connect Claude.
3. Tap the deploy button at the bottom of the form. When the build finishes, open the Worker and copy its address, which looks like `https://garmin-connector.yourname.workers.dev`.
4. Continue from step 5 under "Setup from a computer" below.

Cloudflare copies this code into a new repository in your GitHub account and redeploys whenever that copy changes.

## Setup from a computer (about 10 minutes)

1. Unzip this folder somewhere you'll keep it, such as Documents.

2. Open a terminal in the folder.
   - Mac: open the Terminal app, type `cd ` (with a space), drag the folder into the Terminal window and press Enter.
   - Windows: open the folder, click the address bar, type `cmd` and press Enter.

3. Install the parts it needs:

   ```
   npm install
   ```

4. Run the setup:

   ```
   npm run setup
   ```

   This does four things in order:
   - Opens your browser to sign in to Cloudflare. Click **Allow**, then come back to the terminal.
   - Publishes the connector. If Cloudflare asks you to choose a workers.dev subdomain, pick any name. When it finishes, it prints an address like `https://garmin-connector.yourname.workers.dev`. Copy it.
   - Asks for `GARMIN_API_KEY`. Paste your Garmin key and press Enter. The key is hidden as you paste; that's normal.
   - Asks for `OWNER_PASSPHRASE`. Type a passphrase of at least 16 characters, such as four unrelated words. You'll type it once when you connect Claude, so keep it somewhere safe.

5. Check it's running: open the address from step 4 in your browser. You should see **Garmin connector is running**.

6. Add it to Claude (on the web or desktop app):
   1. Go to **Customize > Connectors**.
   2. Click **+ Add**, then **Add custom connector**.
   3. Name: `Garmin`. URL: your address with `/mcp` on the end, for example `https://garmin-connector.yourname.workers.dev/mcp`. Click **Continue**.
   4. Authentication: **Sign in now**. OAuth client: **Use Claude's published identity**. Click **Add**, then **Connect**.
   5. A page titled **Connect to your Garmin data** opens. Enter your passphrase and click **Allow**.

7. Try it. In a new chat, ask something like "How did I sleep this week?" or "Summarise my running volume for the last 8 weeks." If Claude doesn't use the connector, click **+** in the chat, choose **Connectors** and switch **Garmin** on.

Once connected, it works on your phone too. You stay signed in as long as you use it at least once every 90 days.

## What Claude can read

| Tool | What it returns |
|---|---|
| `list_activities` | Recent activities, or a date range, with distance, time, pace, heart rate and training load |
| `get_activity` | One activity in depth: pace and grade-adjusted pace, time in each HR zone, cadence, running dynamics, power, training effect, fastest splits, intervals |
| `daily_health` | Day by day: sleep (stages, score, bed and wake time), overnight HRV and status, resting HR, Body Battery, stress, steps, intensity minutes. Up to 31 days per request |
| `training_summary` | Weekly or monthly totals by activity type: sessions, distance, time, elevation, training load, average HR. Up to 400 days |
| `nutrition` | Day by day: calories, protein, carbs and fat against your goals (Garmin's activity-adjusted goal where it has one), totals per meal, hydration and sweat loss, and averages across logged days. Can list each food with its amount (up to 7 days). Up to 14 days per request |
| `garmin_api_get` | Any other Personal API endpoint (weight, SpO2, heart rate zones, hydration and so on) as raw data |

Units are metric (km, min/km). Dates use the time zone in `wrangler.jsonc` (America/Toronto).

## Limits

- Read-only. Garmin's Personal API can't send workouts or routes to your watch.
- Nutrition only covers food logged in Garmin Connect itself.
- Some of Garmin's own calculated metrics (VO2 max, recovery time, training readiness) may be missing. Garmin has been leaving undocumented fields out of what its API returns.
- The free Cloudflare plan allows 10 ms of processing per request. Normal requests use well under that, but the first request after the connector has been idle can occasionally go over and fail with "exceeded resource limits". Asking again usually works. If it happens often, the Workers Paid plan ($5 USD a month) removes the limit with no changes here.

## Looking after it

**Renewing the Garmin key.** Garmin emails you about a week before your key expires. Create a new key in Garmin Connect, then in this folder run:

```
npm run update-key
```

and paste the new key. Claude keeps working without reconnecting.

**Changing the passphrase.** Run `npx wrangler secret put OWNER_PASSPHRASE`. It only matters the next time you connect Claude.

**Changing the time zone.** Edit `TIMEZONE` in `wrangler.jsonc`, then run `npm run deploy`.

**Installing an update.** Replace the `src` folder (and any other changed files) with the new version, then run `npm run deploy`. You don't need to reconnect Claude.

**Turning it off.** Remove the connector in Claude (Customize > Connectors), delete the key in Garmin Connect, and optionally run `npx wrangler delete` to remove it from Cloudflare.

## If something goes wrong

- **Claude says Garmin rejected the API key.** The key expired or was deleted. Create a new one and run `npm run update-key`.
- **The sign-in page says too many wrong attempts.** Wait 15 minutes and try again.
- **Adding the connector fails at the sign-in step.** Remove it, add it again, and under OAuth client choose **Register automatically** instead.
- **The sign-in page says the connector isn't set up.** The passphrase is missing or too short. Run `npx wrangler secret put OWNER_PASSPHRASE`.
- **Anything else.** Run `npm run logs`, repeat what failed in Claude, and the terminal shows what happened.

## How it's protected

- Your Garmin key is stored as an encrypted Cloudflare secret. It's never in these files and can't be viewed again once saved.
- The key is read-only. It can't change your Garmin account, and you can delete it in Garmin Connect at any time.
- Only someone with your passphrase can connect. Five wrong tries locks the sign-in page for 15 minutes.
- Nothing about your Garmin data is stored. Each request is passed to Garmin and the answer goes straight back to Claude. The only stored items are sign-in records, kept hashed and encrypted, and an encrypted copy of Garmin's 24-hour access token.

## Files

- `src/index.ts`: routing and sign-in setup
- `src/authorize.ts`: the passphrase page
- `src/garmin.ts`: talks to Garmin's Personal API
- `src/tools.ts`: what Claude can ask for
- `wrangler.jsonc`: Cloudflare settings
