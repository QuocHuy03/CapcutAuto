import argparse
import json
from pathlib import Path
from typing import Any, Dict, List


ROOT = Path(__file__).resolve().parent


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def extract_video_effects(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Lấy danh sách video_effects (id / name / path / category...) từ draft_content."""
    materials = data.get("materials") or {}
    vfx_list = materials.get("video_effects") or []

    out: List[Dict[str, Any]] = []
    for v in vfx_list:
        if not isinstance(v, dict):
            continue
        eff_id = (
            v.get("effect_id")
            or v.get("resource_id")
            or v.get("id")
        )
        if not eff_id:
            continue

        out.append(
            {
                "id": str(eff_id),
                "name": v.get("name") or "",
                "path": v.get("path") or "",
                "category_id": v.get("category_id") or "",
                "category_name": v.get("category_name") or "",
                "type": v.get("type") or "video_effect",
            }
        )

    return out


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Quét draft_content.json để lấy danh sách materials.video_effects "
            "và xuất ra file JSON (id / name / path / category...)."
        )
    )
    parser.add_argument(
        "--draft",
        required=True,
        help="Đường dẫn tới draft_content.json của project CapCut",
    )
    parser.add_argument(
        "--out",
        default="effect_video_catalog.json",
        help="Đường dẫn file JSON output (mặc định: effect_video_catalog.json cạnh draft)",
    )
    args = parser.parse_args()

    draft_path = Path(args.draft)
    if not draft_path.is_file():
        raise SystemExit(f"Không tìm thấy file draft_content.json: {draft_path}")

    data = load_json(draft_path)
    out_path = Path(args.out)
    if not out_path.is_absolute():
        # Nếu user không chỉ định path tuyệt đối → luôn ghi về thư mục tool (ROOT)
        out_path = ROOT / out_path.name

    # Đọc dữ liệu cũ nếu có, để không ghi đè mà chỉ bổ sung effect mới
    existing: Dict[str, Dict[str, Any]] = {}
    if out_path.is_file():
        try:
            old = load_json(out_path)
            if isinstance(old, list):
                for item in old:
                    if isinstance(item, dict):
                        eid = str(item.get("id") or "")
                        if eid:
                            existing[eid] = item
        except Exception:
            pass

    # Quét từ draft hiện tại
    effects = extract_video_effects(data)
    added = 0
    for eff in effects:
        eid = eff.get("id")
        if not eid:
            continue
        # Nếu đã có id này rồi thì bỏ qua, chỉ giữ bản cũ
        if eid in existing:
            continue
        existing[eid] = eff
        added += 1

    # Ghi lại list đã merge (giữ thứ tự theo id cho dễ nhìn)
    merged_list = [existing[k] for k in sorted(existing.keys())]

    out_path.write_text(
        json.dumps(merged_list, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"Đã quét xong video_effects.")
    print(f"Effect mới thêm    : {added}")
    print(f"Tổng số effect lưu : {len(merged_list)}")
    print(f"Lưu vào: {out_path}")


if __name__ == "__main__":
    main()

