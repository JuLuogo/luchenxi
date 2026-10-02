import sys, re
sys.path.insert(0, r"D:\github\luchenxi\_research")
from fetch import fetch, html_to_text, pdf_to_text
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# urls with per-url char limit
URLS = [
    ("https://www.php.cn/faq/1835548.html", 7000),
    ("https://www.php.cn/faq/2497549.html", 7000),
    ("https://mooc1.chaoxing.com/mooc-ans/ztnodedetailcontroller/visitnodedetail?courseId=202992520&knowledgeId=454327651", 8000),
    ("https://www.onlinedown.net/soft/579363.htm", 6000),
    ("https://class.seewo.com/software?b_scene_zt=1", 2000),
]

for url, lim in URLS:
    print("\n" + "#" * 100)
    try:
        raw, ctype = fetch(url)
    except Exception as e:
        print("FETCH_ERROR %s :: %s %s" % (url, type(e).__name__, e))
        continue
    if raw[:5].startswith(b"%PDF") or "pdf" in ctype.lower():
        txt = pdf_to_text(raw)
    else:
        txt = html_to_text(raw)
    txt = re.sub(r"[ \t]+", " ", txt)
    txt = re.sub(r"\n\s*\n+", "\n", txt)
    print("=== %s | %d bytes | %s ===" % (url, len(raw), ctype))
    print(txt[:lim])
