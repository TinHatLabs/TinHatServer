"""The Tin Hat phone apps' link files at the zone apex (tinhat.me): the apps claim `*.tinhat.me`, and iOS and Android
verify a wildcard at the parent name. The same two documents every Tin Hat Server serves itself (appliance templates.py
apple_app_site_association / assetlinks; tests/test_applinks.py keeps them equal). docs/DEEPLINKS.md."""
import json

IOS_APP_IDS = ("3XKTU7LCGT.dev.tinhat.TinHat",)
ANDROID_PACKAGE = "dev.tinhat.android"
ANDROID_CERT_SHA256 = ("C9:EC:B6:BA:A1:6C:59:4C:E9:7B:97:A1:0B:CA:36:CE:B6:16:13:65:52:CE:FA:A0:8A:08:E8:8A:AA:F0:FE:20",)
APP_LINK_FRAGMENTS = (("/room/*", "a room or a message"), ("/user/*", "someone's profile"),
                      ("/register", "making an account"),
                      ("/register?token=*", "an invitation to make an account"))


def apple_app_site_association() -> str:
    comps = [{"/": "/", "#": f, "comment": c} for f, c in APP_LINK_FRAGMENTS]
    # links only: no webcredentials / get_login_creds (sharing saved sign-ins is a domain-wide grant of its own; not
    # part of this, review 2026-10-26)
    return json.dumps({"applinks": {"details": [{"appIDs": list(IOS_APP_IDS), "components": comps}]}}, indent=1) + "\n"


def assetlinks() -> str:
    return json.dumps([{"relation": ["delegate_permission/common.handle_all_urls"],
                        "target": {"namespace": "android_app", "package_name": ANDROID_PACKAGE,
                                   "sha256_cert_fingerprints": list(ANDROID_CERT_SHA256)}}], indent=1) + "\n"
