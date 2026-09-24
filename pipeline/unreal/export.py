"""Exports the Fashion Rotunda assets out of the Unreal project as glTF, PNG, JSON and audio files.

This is the intended Unreal Editor commandlet payload. `pipeline/unreal/run.mjs` presently performs a
read-only, fail-closed provenance audit and does not launch this script; a launcher may be enabled only
after UE 5.8 is available and every Unreal project-generated write is proven external to the read-only
authoritative project. Everything this script emits is written under the folder named by the
FR_EXPORT_OUT environment variable. FR_EXPORT_OUT must be a new directory under
FR_EXPORT_EVIDENCE_ROOT; the script never falls back to a machine-specific or known-good asset path.

Output layout (all paths relative to FR_EXPORT_OUT):
  rotunda.glb                 Lvl_Construction without the pedestal, baked materials, metres
  plinth.glb                  SM_Pedestal_A
  level-main.glb              Lvl_Main with every sublevel, for the light rig and the layout reference
  looks/<slug>/<Mesh>.glb     each garment mesh of a look (its LOD 0 source model, as authored)
  looks/<slug>/mannequin.glb  the look's mannequin with its base material
  looks/<slug>/swatch-*.glb   the base, light and dark mannequin materials as glTF materials
  looks/<slug>/thumbnail.png  the catalogue thumbnail
  looks/<slug>/textures/*.png the look's source textures (BC, NM, ORM) for repairs the exporter cannot make
  rotunda/textures/*.png      the construction set's source textures, same purpose
  audio/                      every sound wave under /Game/Audio
  datatables/*.json           DT_Dresses and DT_StudioLights as the editor exports them
  lights.json                 every light component of Lvl_Main with its transform and parameters
  audit.json                  triangles per LOD, materials and bounds per mesh; size and format per texture
  catalog-source.json         the seven looks with names, descriptions and the files above
  export-report.json          one entry per export call with its result and messages
"""
import json
import os
import re
import time

import unreal

OUT = os.path.abspath(os.environ.get("FR_EXPORT_OUT", ""))
EVIDENCE_ROOT = os.path.abspath(os.environ.get("FR_EXPORT_EVIDENCE_ROOT", ""))
if not OUT:
    raise RuntimeError("FR_EXPORT_OUT is required; refusing to export into a fallback path")
if not EVIDENCE_ROOT:
    raise RuntimeError("FR_EXPORT_EVIDENCE_ROOT is required; refusing an unbounded export destination")
try:
    is_isolated = os.path.commonpath([OUT, EVIDENCE_ROOT]) == EVIDENCE_ROOT
except ValueError:
    is_isolated = False
if not is_isolated or OUT == EVIDENCE_ROOT:
    raise RuntimeError("FR_EXPORT_OUT must be a child of FR_EXPORT_EVIDENCE_ROOT")
if os.path.exists(OUT):
    raise RuntimeError(f"FR_EXPORT_OUT already exists; refusing to overwrite {OUT}")
LEVEL_MAIN = "/Game/Levels/Lvl_Main"
LEVEL_CONSTRUCTION = "/Game/Levels/Lvl_Construction"
GARMENTS = "/Game/Assets/Garments"
ASSETS = "/Game/Assets"
AUDIO = "/Game/Audio"
DRESSES_TABLE = "/Game/DataTables/DT_Dresses"
LIGHTS_TABLE = "/Game/DataTables/DT_StudioLights"
PLINTH_MESH_NAME = "SM_Pedestal_A"
# The garment's share of the first look budget (160,000 triangles with the mannequin). Since
# 2026-09-19 a look ships as authored within 340,000 triangles (pipeline/gltf/lib/budget.mjs) and
# every garment exports its LOD 0 source model; the value is only recorded per garment, unchanged so
# that a new export stays comparable with the known-good one.
GARMENT_BUDGET = 150_000

EAL = unreal.EditorAssetLibrary
DTL = unreal.DataTableFunctionLibrary

report = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "out": OUT, "exports": [], "notes": []}


def log(message):
    unreal.log(f"[fr-export] {message}")


def note(message):
    report["notes"].append(message)
    log(message)


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def asset_name(path):
    return path.split("/")[-1].split(".")[0]


def asset_class(path):
    data = EAL.find_asset_data(path)
    return str(data.asset_class_path.asset_name)


def plain(value):
    """Turns an Unreal value into something json.dump accepts."""
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    if isinstance(value, (unreal.Color, unreal.LinearColor)):
        return [value.r, value.g, value.b, value.a]
    if isinstance(value, unreal.Vector):
        return [value.x, value.y, value.z]
    if isinstance(value, unreal.Rotator):
        return {"roll": value.roll, "pitch": value.pitch, "yaw": value.yaw}
    return str(value)


def make_options(lod=0, bake=None, source=False):
    """Export options. `bake` fixes the baked texture size in pixels; None lets the exporter pick it from
    the textures a material uses, which gave the level's tiled marble materials only 1024 pixels.
    `source` exports the source model instead of the render data: for a Nanite mesh the render LOD 0 is
    Unreal's own decimated fallback, built for each mesh on its own, and a dress fallback and a mannequin
    fallback decimated apart let the mannequin poke through the dress (user diagnosis, 2026-09-19).
    Garments and mannequins therefore export as authored; any reduction happens in the pipeline."""
    options = unreal.GLTFExportOptions()
    options.set_editor_property("export_source_model", source)
    if bake is not None:
        size = unreal.GLTFMaterialBakeSize()
        size.set_editor_property("x", bake)
        size.set_editor_property("y", bake)
        size.set_editor_property("auto_detect", False)
        options.set_editor_property("default_material_bake_size", size)
    options.set_editor_property("export_uniform_scale", 0.01)
    options.set_editor_property("bake_material_inputs", unreal.GLTFMaterialBakeMode.USE_MESH_DATA)
    options.set_editor_property("texture_image_format", unreal.GLTFTextureImageFormat.PNG)
    options.set_editor_property("adjust_normalmaps", True)
    options.set_editor_property("export_lights", True)
    options.set_editor_property("export_cameras", True)
    options.set_editor_property("export_hidden_in_game", False)
    options.set_editor_property("use_mesh_quantization", False)
    options.set_editor_property("export_vertex_colors", False)
    options.set_editor_property("export_level_sequences", False)
    options.set_editor_property("export_animation_sequences", False)
    options.set_editor_property("export_proxy_materials", True)
    options.set_editor_property("export_preview_mesh", True)
    options.set_editor_property("default_level_of_detail", lod)
    return options


def export_gltf(obj, path, options, actors=None, label=""):
    ensure_dir(os.path.dirname(path))
    started = time.time()
    messages = unreal.GLTFExporter.export_to_gltf(obj, path, options, set(actors or []))
    ok = messages is not None and os.path.exists(path)
    entry = {
        "label": label,
        "object": obj.get_path_name(),
        "path": path,
        "ok": ok,
        "seconds": round(time.time() - started, 1),
        "bytes": os.path.getsize(path) if os.path.exists(path) else 0,
    }
    if messages is not None:
        entry["errors"] = [str(m) for m in messages.errors]
        entry["warnings"] = [str(m) for m in messages.warnings]
        entry["suggestions"] = [str(m) for m in messages.suggestions]
    report["exports"].append(entry)
    log(f"{'ok' if ok else 'FAILED'} {label} -> {path} ({entry['bytes']} bytes, {entry['seconds']} s)")
    return entry


def export_texture_png(asset_path, out_path):
    ensure_dir(os.path.dirname(out_path))
    texture = EAL.load_asset(asset_path)
    task = unreal.AssetExportTask()
    task.set_editor_property("object", texture)
    task.set_editor_property("filename", out_path)
    task.set_editor_property("exporter", unreal.TextureExporterPNG())
    task.set_editor_property("automated", True)
    task.set_editor_property("replace_identical", True)
    task.set_editor_property("prompt", False)
    ok = unreal.Exporter.run_asset_export_task(task)
    entry = {"label": "texture", "object": asset_path, "path": out_path, "ok": bool(ok) and os.path.exists(out_path)}
    report["exports"].append(entry)
    log(f"{'ok' if entry['ok'] else 'FAILED'} texture -> {out_path}")
    return entry


def load_level(path):
    """Loads a level into the editor world and returns (world, actors)."""
    loaded = False
    try:
        loaded = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).load_level(path)
    except Exception as error:  # noqa: BLE001
        note(f"LevelEditorSubsystem.load_level failed for {path}: {error}")
    if not loaded:
        world = unreal.EditorLoadingAndSavingUtils.load_map(path)
        if world is None:
            raise RuntimeError(f"could not load level {path}")
    try:
        world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    except Exception:  # noqa: BLE001
        world = unreal.EditorLevelLibrary.get_editor_world()
    try:
        actors = list(unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors())
    except Exception:  # noqa: BLE001
        actors = list(unreal.EditorLevelLibrary.get_all_level_actors())
    log(f"level {path}: {len(actors)} actors")
    return world, actors


def pick_lod(mesh, budget):
    """The first LOD whose triangle count fits the budget; LOD 0 when it fits already."""
    counts = [mesh.get_num_triangles(i) for i in range(mesh.get_num_lods())]
    for index, count in enumerate(counts):
        if count <= budget:
            return index, counts
    return len(counts) - 1, counts


def dump_lights(actors):
    lights = []
    for actor in actors:
        try:
            components = actor.get_components_by_class(unreal.LightComponentBase)
        except Exception:  # noqa: BLE001
            continue
        for component in components:
            entry = {
                "actor": actor.get_actor_label(),
                "actor_class": actor.get_class().get_name(),
                "component": component.get_name(),
                "class": component.get_class().get_name(),
            }
            for prop in (
                "intensity", "intensity_units", "light_color", "temperature", "use_temperature",
                "attenuation_radius", "source_radius", "soft_source_radius", "source_length", "source_width",
                "source_height", "barn_door_angle", "barn_door_length", "inner_cone_angle", "outer_cone_angle",
                "light_source_angle", "indirect_lighting_intensity", "volumetric_scattering_intensity",
                "cast_shadows", "mobility", "visible", "hidden_in_game", "specular_scale",
            ):
                try:
                    entry[prop] = plain(component.get_editor_property(prop))
                except Exception:  # noqa: BLE001
                    pass
            try:
                entry["location_cm"] = plain(component.get_world_location())
                entry["rotation_deg"] = plain(component.get_world_rotation())
                entry["forward"] = plain(component.get_forward_vector())
            except Exception:  # noqa: BLE001
                pass
            lights.append(entry)
        # The studio light blueprints expose their panel values as a struct; keep its text form too.
        for prop in ("exposed_light_params", "hidden_light_params", "light_tag"):
            try:
                value = actor.get_editor_property(prop)
                lights.append({"actor": actor.get_actor_label(), "property": prop, "value": str(value)})
            except Exception:  # noqa: BLE001
                pass
    return lights


def export_data_table(path, out_path):
    table = EAL.load_asset(path)
    text = DTL.export_data_table_to_json_string(table)
    ensure_dir(os.path.dirname(out_path))
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(text or "[]")
    log(f"data table {path} -> {out_path}")
    return json.loads(text) if text else []


def audit_assets():
    audit = {}
    for path in EAL.list_assets(ASSETS, recursive=True, include_folder=False):
        cls = asset_class(path)
        entry = {"class": cls}
        try:
            if cls == "StaticMesh":
                mesh = EAL.load_asset(path)
                entry["triangles_per_lod"] = [mesh.get_num_triangles(i) for i in range(mesh.get_num_lods())]
                entry["vertices_lod0"] = mesh.get_num_vertices(0)
                entry["sections_lod0"] = mesh.get_num_sections(0)
                entry["materials"] = [
                    m.material_interface.get_path_name() if m.material_interface else None for m in mesh.static_materials
                ]
                bounds = mesh.get_bounds()
                entry["bounds_extent_cm"] = plain(bounds.box_extent)
                entry["nanite"] = bool(mesh.get_editor_property("nanite_settings").enabled)
            elif cls == "Texture2D":
                texture = EAL.load_asset(path)
                entry["size"] = [texture.blueprint_get_size_x(), texture.blueprint_get_size_y()]
                entry["srgb"] = bool(texture.get_editor_property("srgb"))
                entry["compression"] = str(texture.get_editor_property("compression_settings"))
        except Exception as error:  # noqa: BLE001
            entry["error"] = str(error)
        audit[path] = entry
    return audit


def main():
    ensure_dir(OUT)
    log(f"engine {unreal.SystemLibrary.get_engine_version()}, output {OUT}")

    # 1. Audit first: it is the G1.1 deliverable and it drives the LOD choice below.
    audit = audit_assets()
    with open(os.path.join(OUT, "audit.json"), "w", encoding="utf-8") as handle:
        json.dump(audit, handle, indent=1)
    log(f"audit: {len(audit)} assets")

    # 2. Data tables.
    dresses = export_data_table(DRESSES_TABLE, os.path.join(OUT, "datatables", "DT_Dresses.json"))
    export_data_table(LIGHTS_TABLE, os.path.join(OUT, "datatables", "DT_StudioLights.json"))

    # 3. The looks, discovered from the dress table's actor class names.
    garment_assets = list(EAL.list_assets(GARMENTS, recursive=True, include_folder=False))
    catalog = {"looks": [], "rotunda": None, "plinth": None, "level_main": None}
    for row in dresses:
        name = row.get("DressName") or row.get("Name")
        actor = str(row.get("Actor", ""))
        key = re.sub(r"_(Dress|Suit)$", "", re.sub(r"^BP_", "", asset_name(actor.split("'")[1] if "'" in actor else actor)))
        slug = slugify(name)
        folder = os.path.join(OUT, "looks", slug)
        matching = [p for p in garment_assets if key.lower() in asset_name(p).lower()]
        meshes = [p for p in matching if asset_class(p) == "StaticMesh"]
        swatches = [p for p in matching if asset_class(p) == "MaterialInstanceConstant" and "mannequin" in asset_name(p).lower()]
        look = {
            "slug": slug, "name": name, "key": key, "description": row.get("Description"),
            "garments": [], "mannequin": None, "swatches": {}, "thumbnail": None,
            "row": row.get("Name"),
        }
        for mesh_path in meshes:
            mesh = EAL.load_asset(mesh_path)
            mesh_name = asset_name(mesh_path)
            counts = [mesh.get_num_triangles(i) for i in range(mesh.get_num_lods())]
            nanite = bool(mesh.get_editor_property("nanite_settings").enabled)
            if "mannequin" in mesh_name.lower():
                path = os.path.join(folder, "mannequin.glb")
                entry = export_gltf(mesh, path, make_options(0, source=True), label=f"{slug} mannequin source")
                look["mannequin"] = {"asset": mesh_path, "file": path, "source_model": True, "nanite": nanite,
                                     "render_triangles_per_lod": counts, "ok": entry["ok"]}
            else:
                path = os.path.join(folder, f"{mesh_name}.glb")
                entry = export_gltf(mesh, path, make_options(0, source=True), label=f"{slug} {mesh_name} source")
                look["garments"].append({"asset": mesh_path, "file": path, "source_model": True, "nanite": nanite,
                                         "render_triangles_per_lod": counts, "budget": GARMENT_BUDGET, "ok": entry["ok"]})
        for swatch_path in swatches:
            variant = asset_name(swatch_path).split("_")[-1].lower()
            material = EAL.load_asset(swatch_path)
            path = os.path.join(folder, f"swatch-{variant}.glb")
            entry = export_gltf(material, path, make_options(0), label=f"{slug} swatch {variant}")
            look["swatches"][variant] = {"asset": swatch_path, "file": path, "ok": entry["ok"]}
        # Source textures beside the baked ones: the exporter maps a wrong slot now and then (the zoot
        # suit's normal input carried its ORM texture), and the optimize pass repairs that by name.
        for texture_path in [p for p in matching if asset_class(p) == "Texture2D"]:
            path = os.path.join(folder, "textures", asset_name(texture_path) + ".png")
            entry = export_texture_png(texture_path, path)
            look.setdefault("textures", []).append({"asset": texture_path, "file": path, "ok": entry["ok"]})
        thumbnail = str(row.get("Thumbnail", ""))
        if "'" in thumbnail:
            thumb_path = thumbnail.split("'")[1]
            path = os.path.join(folder, "thumbnail.png")
            entry = export_texture_png(thumb_path, path)
            look["thumbnail"] = {"asset": thumb_path, "file": path, "ok": entry["ok"]}
        catalog["looks"].append(look)
        log(f"look {slug}: {len(look['garments'])} garment meshes, mannequin {look['mannequin'] is not None}, swatches {sorted(look['swatches'])}")

    # 4. The plinth.
    plinth = [p for p in EAL.list_assets(ASSETS, recursive=True, include_folder=False) if asset_name(p) == PLINTH_MESH_NAME]
    if plinth:
        mesh = EAL.load_asset(plinth[0])
        path = os.path.join(OUT, "plinth.glb")
        entry = export_gltf(mesh, path, make_options(0, bake=2048), label="plinth")
        catalog["plinth"] = {"asset": plinth[0], "file": path, "triangles": mesh.get_num_triangles(0), "ok": entry["ok"]}
    else:
        note(f"{PLINTH_MESH_NAME} not found under {ASSETS}")

    # 4b. The construction set's source textures, for the same repairs.
    construction = "/Game/Assets/Construction"
    for texture_path in [p for p in EAL.list_assets(construction, recursive=True, include_folder=False) if asset_class(p) == "Texture2D"]:
        export_texture_png(texture_path, os.path.join(OUT, "rotunda", "textures", asset_name(texture_path) + ".png"))

    # 5. Audio: everything under /Game/Audio with its default exporter.
    audio_assets = [p for p in EAL.list_assets(AUDIO, recursive=True, include_folder=False) if asset_class(p) == "SoundWave"]
    if audio_assets:
        audio_dir = os.path.join(OUT, "audio")
        ensure_dir(audio_dir)
        try:
            unreal.AssetToolsHelpers.get_asset_tools().export_assets([p.split(".")[0] for p in audio_assets], audio_dir)
            catalog["audio"] = {"assets": audio_assets, "dir": audio_dir, "files": sorted(os.listdir(audio_dir))}
            log(f"audio: {len(audio_assets)} sound waves -> {audio_dir}: {catalog['audio']['files']}")
        except Exception as error:  # noqa: BLE001
            note(f"audio export failed: {error}")

    # 6. The rotunda: the construction level without the pedestal actor.
    world, actors = load_level(LEVEL_CONSTRUCTION)
    rotunda_actors = [a for a in actors if not a.get_actor_label().lower().startswith("bp_pedestal")]
    catalog["rotunda_actors"] = sorted(a.get_actor_label() for a in rotunda_actors)
    path = os.path.join(OUT, "rotunda.glb")
    entry = export_gltf(world, path, make_options(0, bake=2048), actors=rotunda_actors, label="rotunda (Lvl_Construction)")
    catalog["rotunda"] = {"level": LEVEL_CONSTRUCTION, "file": path, "actors": len(rotunda_actors), "ok": entry["ok"]}

    # 7. The main level with its sublevels: the light rig positions and the layout reference.
    world, actors = load_level(LEVEL_MAIN)
    with open(os.path.join(OUT, "lights.json"), "w", encoding="utf-8") as handle:
        json.dump({"level": LEVEL_MAIN, "actors": len(actors), "lights": dump_lights(actors)}, handle, indent=1, default=str)
    path = os.path.join(OUT, "level-main.glb")
    entry = export_gltf(world, path, make_options(0, bake=2048), label="level (Lvl_Main)")
    catalog["level_main"] = {"level": LEVEL_MAIN, "file": path, "actors": len(actors), "ok": entry["ok"]}

    with open(os.path.join(OUT, "catalog-source.json"), "w", encoding="utf-8") as handle:
        json.dump(catalog, handle, indent=1, default=str)
    report["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
    report["failed"] = [e["path"] for e in report["exports"] if not e["ok"]]
    with open(os.path.join(OUT, "export-report.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=1, default=str)
    log(f"done: {len(report['exports'])} exports, {len(report['failed'])} failed")


main()
