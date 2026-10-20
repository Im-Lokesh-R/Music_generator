"""Convert mgtrain.py (cells separated by `# %%`) into a Kaggle/Jupyter notebook."""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "mgtrain.py"), encoding="utf8").read()

cells = []
for block in re.split(r"^# %%", src, flags=re.M):
    if not block.strip():
        continue
    if block.startswith(" [markdown]"):
        lines = block.split("\n")[1:]
        md = "\n".join(l[2:] if l.startswith("# ") else l.lstrip("#") for l in lines).strip()
        cells.append({"cell_type": "markdown", "metadata": {}, "source": md.splitlines(keepends=True)})
    else:
        code = block.strip("\n")
        cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": code.splitlines(keepends=True)})

nb = {
    "cells": cells,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python"},
        "accelerator": "GPU",
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}
out = os.path.join(HERE, "moodcomposer_kaggle.ipynb")
with open(out, "w", encoding="utf8") as f:
    json.dump(nb, f, indent=1)
print(f"wrote {out} ({len(cells)} cells)")
