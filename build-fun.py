# Builds the standalone gregthefrog.fun site from site/greg: paths move from /greg/ to the root,
# the 3D world becomes the homepage. Run: python3 build-fun.py
import os, shutil, re
SRC, OUT = "site/greg", "fun"
shutil.rmtree(OUT, ignore_errors=True); shutil.copytree(SRC, OUT)
p = os.path.join(OUT, "index.html")
if os.path.exists(p): os.remove(p)  # old landing page is dropped
shutil.copy(os.path.join(OUT, "world", "index.html"), os.path.join(OUT, "index.html"))
for root, _, files in os.walk(OUT):
    for f in files:
        if f.endswith((".html", ".js", ".css")):
            p = os.path.join(root, f); s = open(p, encoding="utf-8").read()
            s = s.replace("https://daglabs.com/greg/", "https://gregthefrog.fun/").replace("/greg/", "/").replace('href="/greg"', 'href="/"')
            s = s.replace("@DAGlabsOfficial", "@gregthefrogfun").replace("x.com/DAGlabsOfficial", "x.com/gregthefrogfun")
            open(p, "w", encoding="utf-8").write(s)
open(os.path.join(OUT, "netlify.toml"), "w").write('''[build]
  publish = "."
  command = "echo prebuilt"

[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=604800"

[[headers]]
  for = "/admin/*"
  [headers.values]
    X-Robots-Tag = "noindex, nofollow"
    Cache-Control = "no-store"
''')
open(os.path.join(OUT, "_redirects"), "w").write("/world /world/ 301\n/greg/* /:splat 301\n")
open(os.path.join(OUT, "robots.txt"), "w").write("User-agent: *\nDisallow: /admin/\nSitemap: https://gregthefrog.fun/sitemap.xml\n")
open(os.path.join(OUT, "sitemap.xml"), "w").write('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://gregthefrog.fun/</loc></url><url><loc>https://gregthefrog.fun/golf/</loc></url><url><loc>https://gregthefrog.fun/legal/</loc></url></urlset>')
print("built", OUT)

# root share image alias so gregthefrog.fun/og.png is Greg too
from PIL import Image
Image.open(os.path.join(OUT, "assets", "og-greg.jpg")).convert("RGB").save(os.path.join(OUT, "og.png"))
