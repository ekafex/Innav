# Convert a closed path into Walkable.json

Convert a closed path in svg floor map that should identify the area within which is walkable in the map and convert it int `walkable.json` file required by the app. Run it via:

```python
python3 tools/svg2walkable.py data/floor.svg data/walkable.json --select id=walkable
```



**optioons:**

* `--select` can be `id=...`, `class=...`, or `label=...` (Inkscape layer/label).
* Handles `M/m, L/l, H/h, V/v, Z/z`. (It also reads `<polygon points="...">`.)
* Ignores curves (`C/Q/A/S/T`). If you ever use curves, convert to straight segments in Inkscape (Path → Object to Path; Path → Flatten) or tell me to add curve flattening.

