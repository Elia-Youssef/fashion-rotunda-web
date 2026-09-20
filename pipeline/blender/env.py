"""Convert the authored environment EXR into the small Radiance HDR used by the web app.

Run through Blender so DWA-compressed OpenEXR files are decoded by Blender/OpenImageIO rather
than by ffmpeg, whose EXR decoder does not support every compression mode Poliigon ships.
"""

from pathlib import Path
import sys

import bpy


def arguments() -> tuple[Path, Path, int]:
    try:
        separator = sys.argv.index("--")
        source, output, width_text = sys.argv[separator + 1 :]
    except (ValueError, IndexError, TypeError):
        raise SystemExit("usage: blender --background --python env.py -- SOURCE OUTPUT WIDTH")

    width = int(width_text)
    if width <= 0 or width % 2 != 0:
        raise SystemExit("WIDTH must be a positive even integer")
    return Path(source).resolve(), Path(output).resolve(), width


def main() -> None:
    source, output, width = arguments()
    if not source.is_file():
        raise SystemExit(f"environment source is missing: {source}")

    image = bpy.data.images.load(str(source), check_existing=False)
    source_width, source_height = image.size
    if source_width != source_height * 2:
        raise SystemExit(
            f"environment must be 2:1 equirectangular, got {source_width}x{source_height}"
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    image.scale(width, width // 2)
    image.filepath_raw = str(output)
    image.file_format = "HDR"
    image.save()
    print(f"environment: {source_width}x{source_height} EXR -> {width}x{width // 2} HDR: {output}")


if __name__ == "__main__":
    main()
