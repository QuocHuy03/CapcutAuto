import argparse
import json
from pathlib import Path
from typing import Any, Dict


ROOT = Path(__file__).resolve().parent
ALIAS_PATH = ROOT / "effect_alias.json"


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_alias() -> Dict[str, str]:
    if not ALIAS_PATH.is_file():
        return {}
    try:
        data = load_json(ALIAS_PATH)
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items()}
    except Exception:
        return {}
    return {}


def save_alias(alias: Dict[str, str]) -> None:
    with ALIAS_PATH.open("w", encoding="utf-8") as f:
        json.dump(alias, f, ensure_ascii=False, indent=2)


def visit(node: Any, alias: Dict[str, str], stats: Dict[str, int]) -> None:
    """
    Đệ quy đi qua toàn bộ JSON, tìm key 'material_animations' và
    update alias[id] = name cho từng animation có 'id' + 'name'.
    """
    if isinstance(node, dict):
        # Nếu có trường material_animations trực tiếp
        if "material_animations" in node and isinstance(
            node["material_animations"], list
        ):
            for mat in node["material_animations"]:
                if not isinstance(mat, dict):
                    continue
                anims = mat.get("animations")
                if not isinstance(anims, list):
                    continue
                for anim in anims:
                    if not isinstance(anim, dict):
                        continue
                    eff_id = anim.get("id") or anim.get("resource_id") or anim.get(
                        "third_resource_id"
                    )
                    name = anim.get("name", "") or ""
                    if not eff_id or not name:
                        continue
                    eff_id = str(eff_id)
                    name = str(name)
                    # Chỉ thêm alias mới nếu ID chưa tồn tại để không ghi đè
                    if eff_id not in alias:
                        alias[eff_id] = name
                        stats["updated"] += 1
                    else:
                        stats["unchanged"] += 1

        # Tiếp tục đi sâu
        for v in node.values():
            visit(v, alias, stats)
    elif isinstance(node, list):
        for v in node:
            visit(v, alias, stats)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Quét draft_content.json để lấy tên 'name' trong material_animations "
            "và cập nhật effect_alias.json (id -> name)."
        )
    )
    parser.add_argument(
        "--draft",
        required=True,
        help="Đường dẫn tới draft_content.json của project CapCut",
    )
    args = parser.parse_args()

    draft_path = Path(args.draft)
    if not draft_path.is_file():
        raise SystemExit(f"Không tìm thấy file draft_content.json: {draft_path}")

    data = load_json(draft_path)
    alias = load_alias()

    stats = {"updated": 0, "unchanged": 0}
    visit(data, alias, stats)

    save_alias(alias)

    print("Đã quét xong material_animations.")
    print(f"Alias cập nhật / thêm mới : {stats['updated']}")
    print(f"Alias giữ nguyên          : {stats['unchanged']}")
    print(f"Lưu vào: {ALIAS_PATH}")


if __name__ == "__main__":
    main()

