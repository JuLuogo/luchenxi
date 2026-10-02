import sys, io, os, re, urllib.request, ssl, gzip, zlib

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def fetch(url, timeout=45):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/pdf,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
    })
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        data = r.read()
        enc = r.headers.get("Content-Encoding", "")
        ctype = r.headers.get("Content-Type", "")
    if "gzip" in enc:
        try:
            data = gzip.decompress(data)
        except Exception:
            pass
    elif "deflate" in enc:
        try:
            data = zlib.decompress(data, -zlib.MAX_WBITS)
        except Exception:
            pass
    return data, ctype


def html_to_text(raw):
    for enc in ("utf-8", "gb18030", "gbk", "big5"):
        try:
            s = raw.decode(enc)
            break
        except Exception:
            continue
    else:
        s = raw.decode("utf-8", "replace")
    s = re.sub(r"(?is)<script.*?</script>", " ", s)
    s = re.sub(r"(?is)<style.*?</style>", " ", s)
    s = re.sub(r"(?is)<!--.*?-->", " ", s)
    s = re.sub(r"(?is)<(br|/p|/div|/li|/tr|/h[1-6])[^>]*>", "\n", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    import html as _h
    s = _h.unescape(s)
    s = re.sub(r"[ \t\u00a0\u3000]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()


def pdf_to_text(raw):
    try:
        from pypdf import PdfReader
    except Exception as e:
        return "[pypdf missing: %s]" % e
    try:
        r = PdfReader(io.BytesIO(raw))
        out = []
        for i, p in enumerate(r.pages):
            try:
                out.append(p.extract_text() or "")
            except Exception as e:
                out.append("[page %d error %s]" % (i, e))
            if i > 120:
                out.append("[truncated at 120 pages]")
                break
        return "\n".join(out)
    except Exception as e:
        return "[pdf parse error: %s]" % e


if __name__ == "__main__":
    url = sys.argv[1]
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 20000
    try:
        raw, ctype = fetch(url)
    except Exception as e:
        print("FETCH_ERROR:", type(e).__name__, e)
        sys.exit(2)
    head = raw[:5]
    if head.startswith(b"%PDF") or "pdf" in ctype.lower():
        txt = pdf_to_text(raw)
        kind = "PDF"
    else:
        txt = html_to_text(raw)
        kind = "HTML"
    txt = re.sub(r"[ \t]+", " ", txt)
    print("=== %s | %s | %d bytes | ctype=%s ===" % (kind, url, len(raw), ctype))
    print(txt[:limit])
