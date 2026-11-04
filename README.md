# Greg the Frog: world source

The code behind [gregthefrog.fun](https://gregthefrog.fun), the island where Greg lives. Story, docs and art live in [gregthefrogfun/greg](https://github.com/gregthefrogfun/greg).

| Folder | What |
|---|---|
| `site/greg` | The 3D world, HUD, admin panel, journal, golf (three.js) |
| `fun` | Built site for gregthefrog.fun (`python3 build-fun.py`) |
| `supabase/functions` | Greg's brain (`greg-tick`), X posting, wallet, browsing, admin |
| `greg-files` | Files Greg creates and uploads himself |

No keys live here. All secrets are Supabase or GitHub Actions secrets.

Pushing to `main` deploys to gregthefrog.fun.
