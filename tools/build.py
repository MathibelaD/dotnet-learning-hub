#!/usr/bin/env python3
"""Scans content/ and regenerates content/index.json + content/search.json.

Content contract
----------------
content/<phase-dir>/_phase.json   -> {"order": 1, "title": "...", "blurb": "..."}
content/<phase-dir>/<NN>-<slug>.md with front matter:

    ---
    title: Classes and Constructors
    summary: One line shown in the sidebar and search results.
    minutes: 45
    stage: Stage 1
    ---

Run:  python3 tools/build.py
"""
import json, os, re, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "content")

FM = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)
BLOCK = re.compile(r"^:::[ \t]*([a-z]+)", re.M)
HEADING = re.compile(r"^(#{2,3})[ \t]+(.+?)\s*$", re.M)
CODEFENCE = re.compile(r"^```", re.M)


def parse_front_matter(text):
    m = FM.match(text)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        meta[k.strip()] = v.strip().strip('"')
    return meta, text[m.end():]


def slug_to_title(slug):
    return re.sub(r"^\d+[-_]", "", slug).replace("-", " ").title()


def plain_text(body):
    """Strip the loudest markdown syntax so search matches read cleanly."""
    t = re.sub(r"^:::.*$", " ", body, flags=re.M)
    t = re.sub(r"^#{1,6}\s*", "", t, flags=re.M)
    t = re.sub(r"[*_`>]", "", t)
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"[ \t]+", " ", t)
    return re.sub(r"\n{2,}", "\n", t).strip()


def scan():
    phases = []
    for entry in sorted(os.listdir(CONTENT)):
        pdir = os.path.join(CONTENT, entry)
        meta_path = os.path.join(pdir, "_phase.json")
        if not os.path.isdir(pdir) or not os.path.exists(meta_path):
            continue
        with open(meta_path) as fh:
            pmeta = json.load(fh)

        lessons = []
        for name in sorted(os.listdir(pdir)):
            if not name.endswith(".md") or name.startswith("_"):
                continue
            path = os.path.join(pdir, name)
            with open(path, encoding="utf-8") as fh:
                raw = fh.read()
            meta, body = parse_front_matter(raw)
            counts = {}
            for kind in BLOCK.findall(body):
                counts[kind] = counts.get(kind, 0) + 1
            lesson_id = f"{entry}/{name[:-3]}"
            lessons.append({
                "id": lesson_id,
                "path": f"content/{entry}/{name}",
                "title": meta.get("title") or slug_to_title(name[:-3]),
                "summary": meta.get("summary", ""),
                "minutes": int(meta.get("minutes", 30)),
                "stage": meta.get("stage", ""),
                "blocks": counts,
                "words": len(body.split()),
                "snippets": len(CODEFENCE.findall(body)) // 2,
                "headings": [h[1] for h in HEADING.findall(body) if h[0] == "##"],
            })

        phases.append({
            "id": entry,
            "order": pmeta.get("order", 999),
            "title": pmeta.get("title", slug_to_title(entry)),
            "blurb": pmeta.get("blurb", ""),
            "goal": pmeta.get("goal", ""),
            "lessons": lessons,
        })

    phases.sort(key=lambda p: p["order"])
    return phases


def main():
    if not os.path.isdir(CONTENT):
        sys.exit("content/ directory not found")
    phases = scan()

    index = {
        "generated": datetime.datetime.now().isoformat(timespec="seconds"),
        "phases": phases,
        "totals": {
            "phases": len(phases),
            "lessons": sum(len(p["lessons"]) for p in phases),
            "minutes": sum(l["minutes"] for p in phases for l in p["lessons"]),
            "exercises": sum(l["blocks"].get("exercise", 0) for p in phases for l in p["lessons"]),
            "challenges": sum(l["blocks"].get("challenge", 0) for p in phases for l in p["lessons"]),
            "projectSteps": sum(l["blocks"].get("project", 0) for p in phases for l in p["lessons"]),
            "snippets": sum(l["snippets"] for p in phases for l in p["lessons"]),
        },
    }

    search = []
    for p in phases:
        for l in p["lessons"]:
            with open(os.path.join(ROOT, l["path"]), encoding="utf-8") as fh:
                _, body = parse_front_matter(fh.read())
            search.append({
                "id": l["id"],
                "t": l["title"],
                "p": p["title"],
                "s": l["summary"],
                "h": l["headings"],
                "b": plain_text(body),
            })

    with open(os.path.join(CONTENT, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1, ensure_ascii=False)
    with open(os.path.join(CONTENT, "search.json"), "w", encoding="utf-8") as fh:
        json.dump(search, fh, ensure_ascii=False, separators=(",", ":"))

    t = index["totals"]
    print(f"{t['phases']} phases | {t['lessons']} lessons | {t['exercises']} exercises | "
          f"{t['challenges']} challenges | {t['projectSteps']} project steps | "
          f"{t['snippets']} code snippets | ~{t['minutes'] // 60}h of work")


if __name__ == "__main__":
    main()
