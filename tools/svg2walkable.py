# tools/svg2walkable.py
# Convert <path> (M/L/H/V/Z only) or <polygon> elements from an SVG to walkable.json
# Usage: python3 svg2walkable.py input.svg output.json [--select id=walkable|class=walkable|label=Walkable]

import sys, re, json, xml.etree.ElementTree as ET


def parse_transform_chain(el):
    """Parse simple translate/scale transforms up the DOM tree (optional, works for common cases)."""
    tx = ty = 0.0
    sx = sy = 1.0
    while el is not None:
        t = el.get("transform")
        if t:
            for item in re.finditer(r"(translate|scale)\s*\(([^)]+)\)", t):
                kind, args = (
                    item.group(1),
                    [float(x) for x in re.split(r"[,\s]+", item.group(2).strip()) if x],
                )
                if kind == "translate":
                    if len(args) == 1:
                        tx += args[0]
                    elif len(args) >= 2:
                        tx += args[0]
                        ty += args[1]
                elif kind == "scale":
                    if len(args) == 1:
                        sx *= args[0]
                        sy *= args[0]
                    elif len(args) >= 2:
                        sx *= args[0]
                        sy *= args[1]
        el = (
            el.getparent() if hasattr(el, "getparent") else None
        )  # works if lxml; otherwise no parent
    return sx, sy, tx, ty


def apply_simple_transform(points, sx, sy, tx, ty):
    return [[sx * x + tx, sy * y + ty] for (x, y) in points]


num = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
CMD = re.compile(rf"[MmLlHhVvZz]|{num}")


def path_to_points(dstr):
    """Return list of subpaths as lists of [x,y]; supports M/L/H/V/Z (+ relative)."""
    tokens = CMD.findall(dstr)
    i = 0
    cur = [0.0, 0.0]
    start = None
    polys = []
    cmd = None

    def readnum():
        nonlocal i
        if i >= len(tokens):
            raise ValueError("Unexpected end of path data")
        v = float(tokens[i])
        i += 1
        return v

    while i < len(tokens):
        t = tokens[i]
        if re.fullmatch(r"[MmLlHhVvZz]", t):
            cmd = t
            i += 1
        # If a number appears, SVG repeats the previous non-moveto command.
        if cmd in ("M", "m"):
            # moveto; subsequent pairs are treated as implicit lineto
            x = readnum()
            y = readnum()
            if cmd == "m":
                cur = [cur[0] + x, cur[1] + y]
            else:
                cur = [x, y]
            start = cur[:]
            current_poly = [cur[:]]
            # Consume subsequent coordinate pairs as L/l
            while i < len(tokens) and not re.fullmatch(r"[MmLlHhVvZz]", tokens[i]):
                x = readnum()
                y = readnum()
                nxt = (
                    [current_poly[-1][0] + x, current_poly[-1][1] + y]
                    if cmd == "m"
                    else [x, y]
                )
                current_poly.append(nxt)
                cur = nxt
            polys.append(current_poly)
            continue

        if cmd in ("L", "l"):
            # must have a current_poly already
            if not polys:
                polys.append([cur[:]])
            while i < len(tokens) and not re.fullmatch(r"[MmLlHhVvZz]", tokens[i]):
                x = readnum()
                y = readnum()
                nxt = [cur[0] + x, cur[1] + y] if cmd == "l" else [x, y]
                polys[-1].append(nxt)
                cur = nxt
            continue

        if cmd in ("H", "h"):
            if not polys:
                polys.append([cur[:]])
            while i < len(tokens) and not re.fullmatch(r"[MmLlHhVvZz]", tokens[i]):
                x = readnum()
                nxt = [cur[0] + x, cur[1]] if cmd == "h" else [x, cur[1]]
                polys[-1].append(nxt)
                cur = nxt
            continue

        if cmd in ("V", "v"):
            if not polys:
                polys.append([cur[:]])
            while i < len(tokens) and not re.fullmatch(r"[MmLlHhVvZz]", tokens[i]):
                y = readnum()
                nxt = [cur[0], cur[1] + y] if cmd == "v" else [cur[0], y]
                polys[-1].append(nxt)
                cur = nxt
            continue

        if cmd in ("Z", "z"):
            # close: repeat start point
            if polys and polys[-1]:
                if start is None:
                    start = polys[-1][0]
                if polys[-1][0] != polys[-1][-1]:
                    polys[-1].append(polys[-1][0])
                cur = polys[-1][-1][:]
            start = None
            # Z has no args; loop continues
            continue

        # Unsupported commands fall here
        raise ValueError(f"Unsupported path command: {cmd}")

    # Ensure each subpath is closed
    for poly in polys:
        if poly and poly[0] != poly[-1]:
            poly.append(poly[0])
    return polys


def polygon_points_attr_to_list(s):
    pts = []
    for pair in re.findall(rf"({num})[,\s]+({num})", s.strip()):
        pts.append([float(pair[0]), float(pair[1])])
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts


def select_elements(root, key, val):
    ns = {
        "svg": "http://www.w3.org/2000/svg",
        "ink": "http://www.inkscape.org/namespaces/inkscape",
    }
    elems = []
    # search all paths and polygons
    for el in root.findall(".//{http://www.w3.org/2000/svg}path"):
        if key == "id" and el.get("id") == val:
            elems.append(el)
        elif key == "class" and (val in (el.get("class") or "").split()):
            elems.append(el)
        elif key == "label" and (el.get("{%s}label" % ns["ink"]) == val):
            elems.append(el)
    for el in root.findall(".//{http://www.w3.org/2000/svg}polygon"):
        if key == "id" and el.get("id") == val:
            elems.append(el)
        elif key == "class" and (val in (el.get("class") or "").split()):
            elems.append(el)
        elif key == "label" and (el.get("{%s}label" % ns["ink"]) == val):
            elems.append(el)
    return elems


def main():
    if len(sys.argv) < 3:
        print(
            "Usage: svg2walkable.py input.svg output.json [--select id=walkable|class=walkable|label=Walkable]"
        )
        sys.exit(1)
    inp, outp = sys.argv[1], sys.argv[2]
    key = val = None
    if len(sys.argv) >= 4 and sys.argv[3].startswith("--select"):
        try:
            kv = sys.argv[3].split("=")[1]
            key, val = kv.split("=", 1) if "=" in kv else kv.split(":", 1)
        except Exception:
            print("Bad --select; expected id=..., class=..., or label=...")
            sys.exit(2)

    tree = ET.parse(inp)
    root = tree.getroot()

    elems = []
    if key and val:
        elems = select_elements(root, key, val)
        if not elems:
            print(f"Warning: nothing matched {key}={val}. Scanning all paths/polygons.")
    if not elems:
        elems = root.findall(".//{http://www.w3.org/2000/svg}path") + root.findall(
            ".//{http://www.w3.org/2000/svg}polygon"
        )

    all_polys = []
    for el in elems:
        if el.tag.endswith("path") and el.get("d"):
            try:
                polys = path_to_points(el.get("d"))
            except ValueError as ex:
                print(f"Skipping a path (unsupported commands): {ex}")
                continue
        elif el.tag.endswith("polygon") and el.get("points"):
            polys = [polygon_points_attr_to_list(el.get("points"))]
        else:
            continue

        # Optional: simple translate/scale accumulation (best effort)
        # NOTE: xml.etree doesn't support getparent(); transform chain often on the element itself.
        t = el.get("transform")
        sx = sy = 1.0
        tx = ty = 0.0
        if t:
            for item in re.finditer(r"(translate|scale)\s*\(([^)]+)\)", t):
                kind, args = (
                    item.group(1),
                    [float(x) for x in re.split(r"[,\s]+", item.group(2).strip()) if x],
                )
                if kind == "translate":
                    if len(args) == 1:
                        tx += args[0]
                    elif len(args) >= 2:
                        tx += args[0]
                        ty += args[1]
                elif kind == "scale":
                    if len(args) == 1:
                        sx *= args[0]
                        sy *= args[0]
                    elif len(args) >= 2:
                        sx *= args[0]
                        sy *= args[1]

        for poly in polys:
            pts = apply_simple_transform(poly, sx, sy, tx, ty)
            # Drop duplicate last point for JSON neatness (MapMatcher closes anyway)
            if pts and pts[0] == pts[-1]:
                pts = pts[:-1]
            all_polys.append(pts)

    with open(outp, "w", encoding="utf-8") as f:
        json.dump({"polygons": all_polys}, f, ensure_ascii=False)
    print(f"Wrote {outp} with {len(all_polys)} polygon(s).")


if __name__ == "__main__":
    main()
