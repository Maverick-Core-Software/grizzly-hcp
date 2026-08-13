#!/usr/bin/env python3
"""Copy MCC operator Twilio keys into grizzly-hcp .env as OPS_* (no prints of values)."""
from __future__ import annotations

from pathlib import Path

MCC_ENV = Path(r"C:\Workspace\Active\MCC\.env")
DEST_ENV = Path(r"C:\Workspace\Active\grizzly-hcp\.env")

SRC_TO_DEST = {
    "TWILIO_ACCOUNT_SID": "OPS_TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN": "OPS_TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER": "OPS_SMS_FROM",
    "OPS_SMS_TO": "OPS_SMS_TO",
}


def parse_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        raise SystemExit(f"missing {path}")
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value
    return out


def upsert(path: Path, updates: dict[str, str]) -> list[str]:
    existing_lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    seen: set[str] = set()
    out: list[str] = []
    changed: list[str] = []
    for line in existing_lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in updates:
                out.append(f"{key}={updates[key]}")
                seen.add(key)
                if stripped.split("=", 1)[1] != updates[key]:
                    changed.append(f"updated:{key}")
                else:
                    changed.append(f"unchanged:{key}")
                continue
        out.append(line)
    missing = [key for key in updates if key not in seen]
    if missing:
        if out and out[-1] != "":
            out.append("")
        out.append("# Operator SMS alerts (hermes-pc-sms). Installed from MCC .env.")
        for key in missing:
            out.append(f"{key}={updates[key]}")
            changed.append(f"added:{key}")
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return changed


def main() -> int:
    src = parse_env(MCC_ENV)
    updates: dict[str, str] = {}
    missing_src: list[str] = []
    for src_key, dest_key in SRC_TO_DEST.items():
        value = src.get(src_key, "").strip()
        if not value:
            missing_src.append(src_key)
        else:
            updates[dest_key] = value
    if missing_src:
        print(f"OPS_SMS_INSTALL_FAIL missing_src={','.join(missing_src)}")
        return 1
    actions = upsert(DEST_ENV, updates)
    print(f"OPS_SMS_INSTALL_OK dest={DEST_ENV} actions={','.join(actions)}")
    print(f"OPS_SMS_INSTALL_LENS from={len(updates['OPS_SMS_FROM'])} to={len(updates['OPS_SMS_TO'])} sid={len(updates['OPS_TWILIO_ACCOUNT_SID'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
