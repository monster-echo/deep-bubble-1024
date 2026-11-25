#!/usr/bin/env python3
"""Upload a signed AAB to Google Play internal and production-draft tracks."""
import argparse
import json
import os
import pathlib
import sys
import time
import urllib.request
import urllib.error

NOTES_ROOT = pathlib.Path(__file__).resolve().parent.parent / "release/play-store/release-notes"


def authorize(service_account: dict) -> str:
    import jwt

    now = int(time.time())
    assertion = jwt.encode(
        {
            "iss": service_account["client_email"],
            "scope": "https://www.googleapis.com/auth/androidpublisher",
            "aud": service_account["token_uri"],
            "iat": now,
            "exp": now + 3600,
        },
        service_account["private_key"],
        algorithm="RS256",
    )
    body = (
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion="
        + assertion
    ).encode()
    request = urllib.request.Request(
        service_account["token_uri"],
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)["access_token"]


def release_notes(version: str) -> list[dict]:
    folder = NOTES_ROOT / version
    if not folder.is_dir():
        raise SystemExit(f"Missing release notes folder: {folder}")
    notes = []
    for path in sorted(folder.glob("*.txt")):
        value = path.read_text(encoding="utf-8").strip()[:500]
        if value:
            notes.append({"language": path.stem, "text": value})
    if not any(note["language"] == "en-US" for note in notes):
        raise SystemExit("release/play-store/release-notes/<version>/en-US.txt is required")
    return notes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", required=True)
    parser.add_argument("--aab", required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()

    service_account = json.loads(os.environ["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"])
    api_root = (
        "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/"
        + args.package
    )
    upload_root = (
        "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/"
        + args.package
    )
    headers = {"Authorization": "Bearer " + authorize(service_account)}

    def call(method: str, path: str, data=None, content_type="application/json"):
        payload = json.dumps(data).encode() if isinstance(data, (dict, list)) else (data or b"")
        request = urllib.request.Request(
            api_root + path,
            data=payload,
            method=method,
            headers={**headers, "Content-Type": content_type},
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise SystemExit(
                f"Google Play API {error.code} {error.reason}: {detail}"
            ) from None

    notes = release_notes(args.version)
    edit = call("POST", "/edits")["id"]
    print("Created Google Play edit")
    bundle_request = urllib.request.Request(
        f"{upload_root}/edits/{edit}/bundles?uploadType=media",
        data=pathlib.Path(args.aab).read_bytes(),
        method="POST",
        headers={**headers, "Content-Type": "application/octet-stream"},
    )
    try:
        with urllib.request.urlopen(bundle_request, timeout=600) as response:
            bundle = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(
            f"Google Play bundle upload {error.code} {error.reason}: {detail}"
        ) from None
    version_code = str(bundle["versionCode"])
    internal = {
        "name": f"{args.version} ({version_code}) internal",
        "versionCodes": [version_code],
        "status": "completed",
        "releaseNotes": notes,
    }
    production = {
        "name": f"{args.version} ({version_code})",
        "versionCodes": [version_code],
        "status": "draft",
        "releaseNotes": notes,
    }
    call("PUT", f"/edits/{edit}/tracks/internal", {"track": "internal", "releases": [internal]})
    call("PUT", f"/edits/{edit}/tracks/production", {"track": "production", "releases": [production]})
    call("POST", f"/edits/{edit}:commit")
    print(f"Uploaded versionCode {version_code}: internal completed, production draft")
    return 0


if __name__ == "__main__":
    sys.exit(main())
